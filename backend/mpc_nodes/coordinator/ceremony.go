// Package coordinator implements the MPC key generation and signing ceremony coordination
package coordinator

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"sync"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/decred/dcrd/dcrec/secp256k1/v4/ecdsa"
	"github.com/pkg/errors"
	"github.com/stellaryield/mpc_nodes/storage"
	"github.com/stellaryield/mpc_nodes/tss"
)

// CeremonyType represents the type of ceremony
type CeremonyType string

const (
	// KeyGenCeremony is a distributed key generation ceremony
	KeyGenCeremony CeremonyType = "KEY_GEN"
	// SigningCeremony is a distributed signing ceremony
	SigningCeremony CeremonyType = "SIGNING"
)

// CeremonyPhase represents the current phase of a ceremony
type CeremonyPhase string

const (
	PhaseInit     CeremonyPhase = "INIT"
	PhaseCommit   CeremonyPhase = "COMMIT"
	PhaseReveal   CeremonyPhase = "REVEAL"
	PhaseVerify   CeremonyPhase = "VERIFY"
	PhaseComplete CeremonyPhase = "COMPLETE"
	PhaseFailed   CeremonyPhase = "FAILED"
)

// AuditEventType classifies a structured audit event.
type AuditEventType string

const (
	AuditPhaseStart       AuditEventType = "PHASE_START"
	AuditMessageAccepted  AuditEventType = "MESSAGE_ACCEPTED"
	AuditMessageRejected  AuditEventType = "MESSAGE_REJECTED"
	AuditTimeout          AuditEventType = "TIMEOUT"
	AuditCeremonyComplete AuditEventType = "CEREMONY_COMPLETE"
)

// AuditEvent is a single structured log entry emitted by the coordinator.
type AuditEvent struct {
	EventType     AuditEventType `json:"event_type"`
	SessionID     string         `json:"session_id"`
	Phase         CeremonyPhase  `json:"phase"`
	ParticipantID string         `json:"participant_id,omitempty"`
	Message       string         `json:"message"`
	Timestamp     int64          `json:"timestamp"`
}

// AuditLogger receives structured audit events from the ceremony coordinator.
type AuditLogger interface {
	Emit(event AuditEvent)
}

// DefaultAuditLogger writes events as JSON lines to stdout.
type DefaultAuditLogger struct{}

func (l *DefaultAuditLogger) Emit(event AuditEvent) {
	data, _ := json.Marshal(event)
	fmt.Printf("[AUDIT] %s\n", string(data))
}

// CeremonyMessage represents a message exchanged during a ceremony.
// Every field except Signature is included in the canonical hash that the
// sender signs, binding the message to a specific session, phase, participant,
// timestamp, sequence number, and payload.
type CeremonyMessage struct {
	Type        CeremonyType    `json:"type"`
	Phase       CeremonyPhase   `json:"phase"`
	SessionID   string          `json:"session_id"`
	SenderID    string          `json:"sender_id"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	Signature   []byte          `json:"signature,omitempty"`
	Timestamp   int64           `json:"timestamp"`
	Sequence    uint64          `json:"sequence"`
	PayloadHash []byte          `json:"payload_hash,omitempty"`
}

// KeyGenCommitPayload contains commitment data for key generation
type KeyGenCommitPayload struct {
	PartyID    string `json:"party_id"`
	Commitment []byte `json:"commitment"`
	Nonce      []byte `json:"nonce"`
}

// KeyGenRevealPayload contains reveal data for key generation
type KeyGenRevealPayload struct {
	PartyID   string   `json:"party_id"`
	Share     *big.Int `json:"share"`
	Nonce     []byte   `json:"nonce"`
	PublicKey []byte   `json:"public_key"`
}

// SigningCommitPayload contains commitment data for signing
type SigningCommitPayload struct {
	PartyID    string   `json:"party_id"`
	SessionID  string   `json:"session_id"`
	Commitment []byte   `json:"commitment"`
	R          *big.Int `json:"r"`
}

// SigningRevealPayload contains reveal data for signing
type SigningRevealPayload struct {
	PartyID   string   `json:"party_id"`
	SessionID string   `json:"session_id"`
	R         *big.Int `json:"r"`
	S         *big.Int `json:"s"`
	Nonce     []byte   `json:"nonce"`
}

// CeremonyConfig holds configuration for ceremony coordination
type CeremonyConfig struct {
	// Threshold is the minimum parties needed (t)
	Threshold int
	// TotalParties is the total number of parties (n)
	TotalParties int
	// PartyID is this party's identifier
	PartyID string
	// Timeout is the maximum time to wait for each ceremony phase
	Timeout time.Duration
	// Storage is used for persisting key shares
	Storage storage.KeyShareStorage
	// ParticipantKeys maps each participant ID to their secp256k1 public key,
	// used to authenticate incoming messages. Must include all expected parties.
	ParticipantKeys map[string]*secp256k1.PublicKey
	// PrivateKey is this coordinator's signing key for outgoing messages.
	PrivateKey *secp256k1.PrivateKey
}

// Validate checks if the configuration is valid
func (c *CeremonyConfig) Validate() error {
	if c.Threshold <= 0 {
		return errors.New("threshold must be positive")
	}
	if c.TotalParties <= 0 {
		return errors.New("total parties must be positive")
	}
	if c.Threshold > c.TotalParties {
		return errors.New("threshold cannot exceed total parties")
	}
	if c.PartyID == "" {
		return errors.New("party ID cannot be empty")
	}
	if len(c.ParticipantKeys) == 0 {
		return errors.New("participant keys cannot be empty")
	}
	if len(c.ParticipantKeys) != c.TotalParties {
		return fmt.Errorf("participant key count must equal total parties: got %d, want %d", len(c.ParticipantKeys), c.TotalParties)
	}
	if _, ok := c.ParticipantKeys[c.PartyID]; !ok {
		return errors.New("party ID must exist in participant keys")
	}
	for partyID, publicKey := range c.ParticipantKeys {
		if partyID == "" {
			return errors.New("participant ID cannot be empty")
		}
		if publicKey == nil {
			return fmt.Errorf("participant %q public key cannot be nil", partyID)
		}
	}
	if c.PrivateKey == nil {
		return errors.New("private key cannot be nil")
	}
	if c.Timeout <= 0 {
		c.Timeout = 5 * time.Minute
	}
	return nil
}

// CeremonyCoordinator coordinates MPC ceremonies
type CeremonyCoordinator struct {
	config             *CeremonyConfig
	tssCoordinator     *tss.TSSCoordinator
	currentPhase       CeremonyPhase
	sessionID          string
	participants       map[string]bool
	receivedCommits    map[string]*CeremonyMessage
	receivedReveals    map[string]*CeremonyMessage
	mu                 sync.RWMutex
	messageChan        chan *CeremonyMessage
	errorChan          chan error
	resultChan         chan interface{}
	auditLogger        AuditLogger
	failedParticipants []string
}

// NewCeremonyCoordinator creates a new ceremony coordinator
func NewCeremonyCoordinator(config *CeremonyConfig) (*CeremonyCoordinator, error) {
	if err := config.Validate(); err != nil {
		return nil, errors.Wrap(err, "invalid ceremony config")
	}

	tssConfig := &tss.TSSConfig{
		Threshold:    config.Threshold,
		TotalParties: config.TotalParties,
		PartyID:      config.PartyID,
	}

	tssCoord, err := tss.NewTSSCoordinator(tssConfig)
	if err != nil {
		return nil, errors.Wrap(err, "failed to create TSS coordinator")
	}

	return &CeremonyCoordinator{
		config:          config,
		tssCoordinator:  tssCoord,
		currentPhase:    PhaseInit,
		participants:    make(map[string]bool),
		receivedCommits: make(map[string]*CeremonyMessage),
		receivedReveals: make(map[string]*CeremonyMessage),
		messageChan:     make(chan *CeremonyMessage, 100),
		errorChan:       make(chan error, 10),
		resultChan:      make(chan interface{}, 10),
		auditLogger:     &DefaultAuditLogger{},
	}, nil
}

// WithAuditLogger replaces the coordinator's audit logger (useful for tests).
func (c *CeremonyCoordinator) WithAuditLogger(logger AuditLogger) *CeremonyCoordinator {
	c.auditLogger = logger
	return c
}

// StartKeyGenCeremony initiates a distributed key generation ceremony
func (c *CeremonyCoordinator) StartKeyGenCeremony(ctx context.Context) (*tss.KeyGenerationResult, error) {
	c.mu.Lock()
	c.sessionID = generateSessionID()
	c.currentPhase = PhaseInit
	c.participants = make(map[string]bool)
	c.receivedCommits = make(map[string]*CeremonyMessage)
	c.receivedReveals = make(map[string]*CeremonyMessage)
	c.failedParticipants = nil
	c.mu.Unlock()

	// Phase 1: Generate local key share and commitment
	localShare, err := tss.GenerateLocalKeyShare(c.config.PartyID, c.config.TotalParties)
	if err != nil {
		return nil, errors.Wrap(err, "failed to generate local key share")
	}

	if err := c.config.Storage.StoreKeyShare(ctx, c.sessionID, localShare); err != nil {
		return nil, errors.Wrap(err, "failed to store key share")
	}

	commitMsg := &CeremonyMessage{
		Type:      KeyGenCeremony,
		Phase:     PhaseCommit,
		SessionID: c.sessionID,
		SenderID:  c.config.PartyID,
		Payload: mustMarshal(KeyGenCommitPayload{
			PartyID:    c.config.PartyID,
			Commitment: localShare.Commitment.Bytes(),
		}),
		Timestamp: time.Now().Unix(),
	}
	c.broadcastMessage(commitMsg)

	c.mu.Lock()
	c.currentPhase = PhaseCommit
	c.mu.Unlock()

	if err := c.waitForPhase(PhaseCommit, c.config.TotalParties); err != nil {
		return nil, errors.Wrap(err, "commit phase failed")
	}

	// Phase 2: Reveal shares
	revealMsg := &CeremonyMessage{
		Type:      KeyGenCeremony,
		Phase:     PhaseReveal,
		SessionID: c.sessionID,
		SenderID:  c.config.PartyID,
		Payload: mustMarshal(KeyGenRevealPayload{
			PartyID: c.config.PartyID,
			Share:   localShare.SecretShare,
			Nonce:   localShare.Commitment.Bytes(),
		}),
		Timestamp: time.Now().Unix(),
	}
	c.broadcastMessage(revealMsg)

	c.mu.Lock()
	c.currentPhase = PhaseReveal
	c.mu.Unlock()

	if err := c.waitForPhase(PhaseReveal, c.config.TotalParties); err != nil {
		return nil, errors.Wrap(err, "reveal phase failed")
	}

	publicKey, err := c.computeAggregatedPublicKey()
	if err != nil {
		return nil, errors.Wrap(err, "failed to compute public key")
	}

	c.mu.Lock()
	c.currentPhase = PhaseComplete
	c.mu.Unlock()

	c.emitAudit(AuditCeremonyComplete, PhaseComplete, "", "key generation ceremony completed")

	return &tss.KeyGenerationResult{
		PublicKey:      publicKey,
		PublicKeyBytes: publicKey.SerializeCompressed(),
	}, nil
}

// StartSigningCeremony initiates a distributed signing ceremony
func (c *CeremonyCoordinator) StartSigningCeremony(ctx context.Context, messageHash []byte) (*tss.Signature, error) {
	c.mu.Lock()
	c.sessionID = generateSessionID()
	c.currentPhase = PhaseInit
	c.receivedCommits = make(map[string]*CeremonyMessage)
	c.receivedReveals = make(map[string]*CeremonyMessage)
	c.failedParticipants = nil
	c.mu.Unlock()

	session, err := c.tssCoordinator.StartSigningSession(messageHash)
	if err != nil {
		return nil, errors.Wrap(err, "failed to start signing session")
	}

	r, err := rand.Int(rand.Reader, secp256k1.S256().N)
	if err != nil {
		return nil, errors.Wrap(err, "failed to generate random value")
	}

	commitment, err := tss.GenerateCommitment(r)
	if err != nil {
		return nil, errors.Wrap(err, "failed to generate commitment")
	}

	commitMsg := &CeremonyMessage{
		Type:      SigningCeremony,
		Phase:     PhaseCommit,
		SessionID: c.sessionID,
		SenderID:  c.config.PartyID,
		Payload: mustMarshal(SigningCommitPayload{
			PartyID:    c.config.PartyID,
			SessionID:  c.sessionID,
			Commitment: commitment,
			R:          r,
		}),
		Timestamp: time.Now().Unix(),
	}
	c.broadcastMessage(commitMsg)

	c.mu.Lock()
	c.currentPhase = PhaseCommit
	c.mu.Unlock()

	if err := c.waitForPhase(PhaseCommit, c.config.Threshold); err != nil {
		return nil, errors.Wrap(err, "commit phase failed")
	}

	keyShare := c.tssCoordinator.GetKeyShare()
	if keyShare == nil {
		return nil, errors.New("key share not available")
	}

	k := r
	hm := new(big.Int).SetBytes(messageHash)
	dShare := keyShare.Share

	curveN := secp256k1.S256().N
	khm := new(big.Int).Mul(k, hm)
	khm.Mod(khm, curveN)
	rdShare := new(big.Int).Mul(r, dShare)
	rdShare.Mod(rdShare, curveN)
	sShare := new(big.Int).Add(khm, rdShare)
	sShare.Mod(sShare, curveN)

	revealMsg := &CeremonyMessage{
		Type:      SigningCeremony,
		Phase:     PhaseReveal,
		SessionID: c.sessionID,
		SenderID:  c.config.PartyID,
		Payload: mustMarshal(SigningRevealPayload{
			PartyID:   c.config.PartyID,
			SessionID: c.sessionID,
			R:         r,
			S:         sShare,
		}),
		Timestamp: time.Now().Unix(),
	}
	c.broadcastMessage(revealMsg)

	c.mu.Lock()
	c.currentPhase = PhaseReveal
	c.mu.Unlock()

	if err := c.waitForPhase(PhaseReveal, c.config.Threshold); err != nil {
		return nil, errors.Wrap(err, "reveal phase failed")
	}

	signature, err := c.tssCoordinator.GetSignatureResult(session.ID)
	if err != nil {
		return nil, errors.Wrap(err, "failed to get signature result")
	}

	c.mu.Lock()
	c.currentPhase = PhaseComplete
	c.mu.Unlock()

	c.emitAudit(AuditCeremonyComplete, PhaseComplete, "", "signing ceremony completed")

	return signature, nil
}

// HandleMessage processes an incoming message from another participant.
// Validation is performed synchronously: unknown participants, bad signatures,
// wrong session/phase, duplicate messages, and tampered payloads are all rejected.
func (c *CeremonyCoordinator) HandleMessage(msg *CeremonyMessage) error {
	return c.processMessage(msg)
}

// processMessage validates and dispatches an incoming message.
func (c *CeremonyCoordinator) processMessage(msg *CeremonyMessage) error {
	// 1. Payload hash integrity check
	if err := validatePayloadHash(msg); err != nil {
		c.emitAudit(AuditMessageRejected, msg.Phase, msg.SenderID, "payload hash mismatch")
		return errors.Wrap(err, "payload hash validation failed")
	}

	// 2. Authenticate the sender via ECDSA signature
	if err := c.verifyMessageSignature(msg); err != nil {
		c.emitAudit(AuditMessageRejected, msg.Phase, msg.SenderID, err.Error())
		return errors.Wrap(err, "message authentication failed")
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// 3. Bind message to current session, phase, and timestamp window
	if err := c.validateMessageContext(msg); err != nil {
		c.emitAudit(AuditMessageRejected, msg.Phase, msg.SenderID, err.Error())
		return errors.Wrap(err, "message context validation failed")
	}

	var err error
	switch msg.Type {
	case KeyGenCeremony:
		err = c.handleKeyGenMessage(msg)
	case SigningCeremony:
		err = c.handleSigningMessage(msg)
	default:
		err = fmt.Errorf("unknown ceremony type: %s", msg.Type)
	}

	if err != nil {
		c.emitAudit(AuditMessageRejected, msg.Phase, msg.SenderID, err.Error())
		return err
	}

	c.emitAudit(AuditMessageAccepted, msg.Phase, msg.SenderID, "message accepted")
	return nil
}

// handleKeyGenMessage handles key generation ceremony messages
func (c *CeremonyCoordinator) handleKeyGenMessage(msg *CeremonyMessage) error {
	switch msg.Phase {
	case PhaseCommit:
		if _, exists := c.receivedCommits[msg.SenderID]; exists {
			return fmt.Errorf("duplicate commit from participant %s", msg.SenderID)
		}
		c.receivedCommits[msg.SenderID] = msg
		c.participants[msg.SenderID] = true

	case PhaseReveal:
		if _, exists := c.receivedReveals[msg.SenderID]; exists {
			return fmt.Errorf("duplicate reveal from participant %s", msg.SenderID)
		}
		commitMsg, ok := c.receivedCommits[msg.SenderID]
		if !ok {
			return fmt.Errorf("reveal from %s has no prior commit", msg.SenderID)
		}

		var reveal KeyGenRevealPayload
		if err := json.Unmarshal(msg.Payload, &reveal); err != nil {
			return errors.Wrap(err, "failed to unmarshal reveal payload")
		}
		var commit KeyGenCommitPayload
		if err := json.Unmarshal(commitMsg.Payload, &commit); err != nil {
			return errors.Wrap(err, "failed to unmarshal commit payload")
		}
		commitmentHash := sha256.Sum256(append(reveal.Share.Bytes(), reveal.Nonce...))
		if !bytes.Equal(commitmentHash[:], commit.Commitment) {
			return errors.New("commitment mismatch: reveal does not match prior commit")
		}
		c.receivedReveals[msg.SenderID] = msg
	}
	return nil
}

// handleSigningMessage handles signing ceremony messages
func (c *CeremonyCoordinator) handleSigningMessage(msg *CeremonyMessage) error {
	switch msg.Phase {
	case PhaseCommit:
		if _, exists := c.receivedCommits[msg.SenderID]; exists {
			return fmt.Errorf("duplicate signing commit from participant %s", msg.SenderID)
		}
		c.receivedCommits[msg.SenderID] = msg

	case PhaseReveal:
		if _, exists := c.receivedReveals[msg.SenderID]; exists {
			return fmt.Errorf("duplicate signing reveal from participant %s", msg.SenderID)
		}
		var reveal SigningRevealPayload
		if err := json.Unmarshal(msg.Payload, &reveal); err != nil {
			return errors.Wrap(err, "failed to unmarshal signing reveal")
		}
		signingShare := &tss.SigningShare{
			PartyID:    reveal.PartyID,
			R:          reveal.R,
			S:          reveal.S,
			Commitment: reveal.Nonce,
		}
		if err := c.tssCoordinator.AddSigningShare(reveal.SessionID, signingShare); err != nil {
			return errors.Wrap(err, "failed to add signing share")
		}
		c.receivedReveals[msg.SenderID] = msg
	}
	return nil
}

// waitForPhase polls until the required number of messages arrive for a phase,
// or until the timeout fires and failed participants are recorded.
func (c *CeremonyCoordinator) waitForPhase(phase CeremonyPhase, required int) error {
	timeout := time.After(c.config.Timeout)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()

	c.emitAudit(AuditPhaseStart, phase, "",
		fmt.Sprintf("waiting for %d parties in phase %s", required, phase))

	for {
		select {
		case <-timeout:
			c.mu.Lock()
			c.currentPhase = PhaseFailed
			c.failedParticipants = c.computeTimedOutParticipants(phase)
			c.mu.Unlock()
			c.emitAudit(AuditTimeout, phase, "",
				fmt.Sprintf("phase %s timed out; non-responsive participants: %v",
					phase, c.failedParticipants))
			return fmt.Errorf("phase %s timeout; non-responsive: %v", phase, c.failedParticipants)

		case <-ticker.C:
			c.mu.RLock()
			count := c.phaseCount(phase)
			c.mu.RUnlock()
			if count >= required {
				return nil
			}
		}
	}
}

func (c *CeremonyCoordinator) phaseCount(phase CeremonyPhase) int {
	switch phase {
	case PhaseCommit:
		return len(c.receivedCommits)
	case PhaseReveal:
		return len(c.receivedReveals)
	}
	return 0
}

// computeTimedOutParticipants returns IDs of all known participants that did
// not submit a message for the given phase.
func (c *CeremonyCoordinator) computeTimedOutParticipants(phase CeremonyPhase) []string {
	var failed []string
	for id := range c.config.ParticipantKeys {
		var seen bool
		switch phase {
		case PhaseCommit:
			_, seen = c.receivedCommits[id]
		case PhaseReveal:
			_, seen = c.receivedReveals[id]
		}
		if !seen {
			failed = append(failed, id)
		}
	}
	sort.Strings(failed)
	return failed
}

// computeAggregatedPublicKey computes the aggregated public key from all shares
func (c *CeremonyCoordinator) computeAggregatedPublicKey() (*secp256k1.PublicKey, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()

	aggX := big.NewInt(0)
	aggY := big.NewInt(0)
	curve := secp256k1.S256()

	for _, msg := range c.receivedReveals {
		var reveal KeyGenRevealPayload
		if err := json.Unmarshal(msg.Payload, &reveal); err != nil {
			return nil, errors.Wrap(err, "failed to unmarshal reveal")
		}
		x, y := curve.ScalarBaseMult(reveal.Share.Bytes())
		aggX.Add(aggX, x)
		aggY.Add(aggY, y)
	}

	aggX.Mod(aggX, curve.P)
	aggY.Mod(aggY, curve.P)

	var fvX, fvY secp256k1.FieldVal
	fvX.SetByteSlice(aggX.Bytes())
	fvY.SetByteSlice(aggY.Bytes())
	return secp256k1.NewPublicKey(&fvX, &fvY), nil
}

// broadcastMessage signs and registers the coordinator's own outgoing message,
// then queues it on messageChan for the network transport layer.
func (c *CeremonyCoordinator) broadcastMessage(msg *CeremonyMessage) {
	if err := SignMessage(msg, c.config.PrivateKey); err != nil {
		c.errorChan <- errors.Wrap(err, "failed to sign broadcast message")
		return
	}
	// Self-register so the coordinator's own contribution counts in waitForPhase.
	c.mu.Lock()
	switch msg.Type {
	case KeyGenCeremony:
		switch msg.Phase {
		case PhaseCommit:
			c.receivedCommits[msg.SenderID] = msg
			c.participants[msg.SenderID] = true
		case PhaseReveal:
			c.receivedReveals[msg.SenderID] = msg
		}
	case SigningCeremony:
		switch msg.Phase {
		case PhaseCommit:
			c.receivedCommits[msg.SenderID] = msg
		case PhaseReveal:
			c.receivedReveals[msg.SenderID] = msg
		}
	}
	c.mu.Unlock()

	// Non-blocking send; in production the network layer reads from messageChan.
	select {
	case c.messageChan <- msg:
	default:
	}
}

// ── Message signing & verification ───────────────────────────────────────────

// messageCanonicalHash returns SHA-256(type ‖ phase ‖ session_id ‖ sender_id ‖
// timestamp ‖ sequence ‖ payload_hash).  The Signature field is intentionally
// excluded so the hash can be computed before and after signing.
func messageCanonicalHash(msg *CeremonyMessage) []byte {
	h := sha256.New()
	h.Write([]byte(msg.Type))
	h.Write([]byte(msg.Phase))
	h.Write([]byte(msg.SessionID))
	h.Write([]byte(msg.SenderID))

	var ts [8]byte
	binary.BigEndian.PutUint64(ts[:], uint64(msg.Timestamp))
	h.Write(ts[:])

	var seq [8]byte
	binary.BigEndian.PutUint64(seq[:], msg.Sequence)
	h.Write(seq[:])

	h.Write(msg.PayloadHash)
	return h.Sum(nil)
}

// SignMessage sets PayloadHash and signs the message with key.
// Exported so test helpers and participants can sign outgoing messages.
func SignMessage(msg *CeremonyMessage, key *secp256k1.PrivateKey) error {
	if len(msg.Payload) > 0 {
		h := sha256.Sum256(msg.Payload)
		msg.PayloadHash = h[:]
	}
	msgHash := messageCanonicalHash(msg)
	sig := ecdsa.Sign(key, msgHash)
	msg.Signature = sig.Serialize()
	return nil
}

// verifyMessageSignature authenticates a message against the sender's
// registered public key.  Returns an error for unknown participants, missing
// signatures, or failed ECDSA verification.
func (c *CeremonyCoordinator) verifyMessageSignature(msg *CeremonyMessage) error {
	pubKey, ok := c.config.ParticipantKeys[msg.SenderID]
	if !ok {
		return fmt.Errorf("unknown participant: %s", msg.SenderID)
	}
	if len(msg.Signature) == 0 {
		return errors.New("message carries no signature")
	}
	sig, err := ecdsa.ParseDERSignature(msg.Signature)
	if err != nil {
		return errors.Wrap(err, "failed to parse DER signature")
	}
	msgHash := messageCanonicalHash(msg)
	if !sig.Verify(msgHash, pubKey) {
		return fmt.Errorf("ECDSA verification failed for participant %s", msg.SenderID)
	}
	return nil
}

// validatePayloadHash verifies that the declared payload hash matches the actual payload.
func validatePayloadHash(msg *CeremonyMessage) error {
	if len(msg.Payload) == 0 {
		return nil
	}
	expected := sha256.Sum256(msg.Payload)
	if !bytes.Equal(msg.PayloadHash, expected[:]) {
		return errors.New("payload hash does not match payload content")
	}
	return nil
}

// validateMessageContext checks that the message is bound to the current
// session, the current phase, and a recent timestamp (within ±5 minutes).
// A stale session ID is the primary indicator of a replay from a past ceremony.
func (c *CeremonyCoordinator) validateMessageContext(msg *CeremonyMessage) error {
	if msg.SessionID != c.sessionID {
		return fmt.Errorf("session ID mismatch: got %q want %q — possible replay attack",
			msg.SessionID, c.sessionID)
	}
	if msg.Phase != c.currentPhase {
		return fmt.Errorf("phase mismatch: got %s want %s", msg.Phase, c.currentPhase)
	}
	now := time.Now().Unix()
	skew := now - msg.Timestamp
	if skew < 0 {
		skew = -skew
	}
	if skew > 300 {
		return fmt.Errorf("message timestamp %d is outside the ±5 min window (skew: %ds)",
			msg.Timestamp, skew)
	}
	return nil
}

// ── Accessors ────────────────────────────────────────────────────────────────

// GetSessionID returns the current session ID
func (c *CeremonyCoordinator) GetSessionID() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.sessionID
}

// GetCurrentPhase returns the current ceremony phase
func (c *CeremonyCoordinator) GetCurrentPhase() CeremonyPhase {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.currentPhase
}

// GetParticipants returns the list of participants who sent a commit
func (c *CeremonyCoordinator) GetParticipants() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	participants := make([]string, 0, len(c.participants))
	for p := range c.participants {
		participants = append(participants, p)
	}
	return participants
}

// GetFailedParticipants returns the IDs of participants that did not respond
// before the last phase timeout.
func (c *CeremonyCoordinator) GetFailedParticipants() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	result := make([]string, len(c.failedParticipants))
	copy(result, c.failedParticipants)
	return result
}

// ── Audit helpers ─────────────────────────────────────────────────────────────

func (c *CeremonyCoordinator) emitAudit(eventType AuditEventType, phase CeremonyPhase, participantID, message string) {
	if c.auditLogger == nil {
		return
	}
	c.auditLogger.Emit(AuditEvent{
		EventType:     eventType,
		SessionID:     c.sessionID,
		Phase:         phase,
		ParticipantID: participantID,
		Message:       message,
		Timestamp:     time.Now().Unix(),
	})
}

// ── Utilities ────────────────────────────────────────────────────────────────

func generateSessionID() string {
	b := make([]byte, 32)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func mustMarshal(v interface{}) json.RawMessage {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return data
}
