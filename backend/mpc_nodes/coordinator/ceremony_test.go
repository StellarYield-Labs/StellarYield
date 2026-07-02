package coordinator

import (
	"sync"
	"testing"
	"time"

	"github.com/decred/dcrd/dcrec/secp256k1/v4"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ── Test helpers ──────────────────────────────────────────────────────────────

// capturingAuditLogger records every event emitted during a test.
type capturingAuditLogger struct {
	mu     sync.Mutex
	events []AuditEvent
}

func (l *capturingAuditLogger) Emit(event AuditEvent) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.events = append(l.events, event)
}

func (l *capturingAuditLogger) EventTypes() []AuditEventType {
	l.mu.Lock()
	defer l.mu.Unlock()
	types := make([]AuditEventType, len(l.events))
	for i, e := range l.events {
		types[i] = e.EventType
	}
	return types
}

func (l *capturingAuditLogger) HasEventType(t AuditEventType) bool {
	for _, et := range l.EventTypes() {
		if et == t {
			return true
		}
	}
	return false
}

func genKey(t *testing.T) *secp256k1.PrivateKey {
	t.Helper()
	key, err := secp256k1.GeneratePrivateKey()
	require.NoError(t, err)
	return key
}

// participantSet builds a public-key map for a given private-key map.
func participantSet(keys map[string]*secp256k1.PrivateKey) map[string]*secp256k1.PublicKey {
	pub := make(map[string]*secp256k1.PublicKey, len(keys))
	for id, k := range keys {
		pub[id] = k.PubKey()
	}
	return pub
}

// newTestCoordinator creates a coordinator with a short timeout, 3 parties (t=2),
// a capturing audit logger, and the given party ID / private key.
func newTestCoordinator(t *testing.T, partyID string, privKey *secp256k1.PrivateKey,
	allPubKeys map[string]*secp256k1.PublicKey) (*CeremonyCoordinator, *capturingAuditLogger) {
	t.Helper()
	cfg := &CeremonyConfig{
		Threshold:       2,
		TotalParties:    3,
		PartyID:         partyID,
		Timeout:         150 * time.Millisecond,
		ParticipantKeys: allPubKeys,
		PrivateKey:      privKey,
	}
	coord, err := NewCeremonyCoordinator(cfg)
	require.NoError(t, err)
	logger := &capturingAuditLogger{}
	coord.WithAuditLogger(logger)
	return coord, logger
}

// buildCommitMsg creates a signed KeyGen commit message for senderID.
func buildCommitMsg(t *testing.T, key *secp256k1.PrivateKey, senderID, sessionID string) *CeremonyMessage {
	t.Helper()
	msg := &CeremonyMessage{
		Type:      KeyGenCeremony,
		Phase:     PhaseCommit,
		SessionID: sessionID,
		SenderID:  senderID,
		Payload:   mustMarshal(KeyGenCommitPayload{PartyID: senderID, Commitment: []byte("test-commit")}),
		Timestamp: time.Now().Unix(),
	}
	require.NoError(t, SignMessage(msg, key))
	return msg
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TestValidCeremony_AcceptsAuthenticCommits verifies the happy path: three parties
// exchange valid, signed commit messages and all are accepted.
func TestValidCeremony_AcceptsAuthenticCommits(t *testing.T) {
	keys := map[string]*secp256k1.PrivateKey{
		"party-1": genKey(t),
		"party-2": genKey(t),
		"party-3": genKey(t),
	}
	pubKeys := participantSet(keys)

	coord, logger := newTestCoordinator(t, "party-1", keys["party-1"], pubKeys)

	// Put the coordinator into COMMIT phase with a known session
	sessionID := "valid-session-001"
	coord.mu.Lock()
	coord.sessionID = sessionID
	coord.currentPhase = PhaseCommit
	coord.mu.Unlock()

	// party-2 and party-3 send valid commits
	for _, id := range []string{"party-2", "party-3"} {
		msg := buildCommitMsg(t, keys[id], id, sessionID)
		require.NoError(t, coord.HandleMessage(msg), "valid commit from %s should be accepted", id)
	}

	coord.mu.RLock()
	commitCount := len(coord.receivedCommits)
	coord.mu.RUnlock()

	assert.Equal(t, 2, commitCount, "both valid commits should be stored")
	assert.True(t, logger.HasEventType(AuditMessageAccepted),
		"at least one MESSAGE_ACCEPTED audit event expected")
}

// TestReplayAttack_StaleSessionIDRejected verifies that a message carrying an old
// session ID is rejected, protecting against cross-ceremony replay.
func TestReplayAttack_StaleSessionIDRejected(t *testing.T) {
	keys := map[string]*secp256k1.PrivateKey{
		"party-1": genKey(t),
		"party-2": genKey(t),
	}
	pubKeys := participantSet(keys)

	coord, logger := newTestCoordinator(t, "party-1", keys["party-1"], pubKeys)

	currentSession := "current-session-xyz"
	coord.mu.Lock()
	coord.sessionID = currentSession
	coord.currentPhase = PhaseCommit
	coord.mu.Unlock()

	// Build a message signed for a different (old) session
	oldSessionMsg := buildCommitMsg(t, keys["party-2"], "party-2", "old-session-000")

	err := coord.HandleMessage(oldSessionMsg)
	require.Error(t, err, "message from old session must be rejected")
	assert.Contains(t, err.Error(), "session ID mismatch",
		"error should indicate a session mismatch / replay")

	assert.True(t, logger.HasEventType(AuditMessageRejected),
		"MESSAGE_REJECTED audit event expected for replay attempt")

	coord.mu.RLock()
	defer coord.mu.RUnlock()
	assert.Empty(t, coord.receivedCommits,
		"replayed message must not be stored")
}

// TestWrongSigner_SignedByImposterRejected verifies that a message purportedly
// from party-2 but signed with party-3's key is rejected.
func TestWrongSigner_SignedByImposterRejected(t *testing.T) {
	keys := map[string]*secp256k1.PrivateKey{
		"party-1": genKey(t),
		"party-2": genKey(t),
		"party-3": genKey(t),
	}
	pubKeys := participantSet(keys)

	coord, logger := newTestCoordinator(t, "party-1", keys["party-1"], pubKeys)

	sessionID := "imposter-session"
	coord.mu.Lock()
	coord.sessionID = sessionID
	coord.currentPhase = PhaseCommit
	coord.mu.Unlock()

	// Build a message that claims to be from party-2 but is signed by party-3's key
	msg := &CeremonyMessage{
		Type:      KeyGenCeremony,
		Phase:     PhaseCommit,
		SessionID: sessionID,
		SenderID:  "party-2", // claimed identity
		Payload:   mustMarshal(KeyGenCommitPayload{PartyID: "party-2", Commitment: []byte("fake")}),
		Timestamp: time.Now().Unix(),
	}
	// Sign with party-3's key (wrong key)
	require.NoError(t, SignMessage(msg, keys["party-3"]))

	err := coord.HandleMessage(msg)
	require.Error(t, err, "message signed by wrong key must be rejected")
	assert.Contains(t, err.Error(), "ECDSA verification failed",
		"error should indicate signature verification failure")

	assert.True(t, logger.HasEventType(AuditMessageRejected))

	coord.mu.RLock()
	defer coord.mu.RUnlock()
	assert.Empty(t, coord.receivedCommits,
		"message with wrong signature must not be stored")
}

// TestDuplicateCommit_SecondMessageRejected verifies that a party cannot overwrite
// its already-accepted commit by sending a second one.
func TestDuplicateCommit_SecondMessageRejected(t *testing.T) {
	keys := map[string]*secp256k1.PrivateKey{
		"party-1": genKey(t),
		"party-2": genKey(t),
	}
	pubKeys := participantSet(keys)

	coord, logger := newTestCoordinator(t, "party-1", keys["party-1"], pubKeys)

	sessionID := "dup-session"
	coord.mu.Lock()
	coord.sessionID = sessionID
	coord.currentPhase = PhaseCommit
	coord.mu.Unlock()

	first := buildCommitMsg(t, keys["party-2"], "party-2", sessionID)
	require.NoError(t, coord.HandleMessage(first), "first commit should be accepted")

	second := buildCommitMsg(t, keys["party-2"], "party-2", sessionID)
	err := coord.HandleMessage(second)
	require.Error(t, err, "duplicate commit must be rejected")
	assert.Contains(t, err.Error(), "duplicate commit",
		"error should name the duplicate commit")

	assert.True(t, logger.HasEventType(AuditMessageAccepted), "first commit should be accepted")
	assert.True(t, logger.HasEventType(AuditMessageRejected), "second commit should be rejected")

	coord.mu.RLock()
	defer coord.mu.RUnlock()
	assert.Len(t, coord.receivedCommits, 1,
		"only the first commit should be stored")
}

// TestTimeout_RecordsNonResponsiveParticipants verifies that a phase timeout
// advances the phase to FAILED and lists the participants that did not respond.
func TestTimeout_RecordsNonResponsiveParticipants(t *testing.T) {
	keys := map[string]*secp256k1.PrivateKey{
		"party-1": genKey(t),
		"party-2": genKey(t),
		"party-3": genKey(t),
	}
	pubKeys := participantSet(keys)

	// Very short timeout so the test doesn't wait long
	cfg := &CeremonyConfig{
		Threshold:       2,
		TotalParties:    3,
		PartyID:         "party-1",
		Timeout:         80 * time.Millisecond,
		ParticipantKeys: pubKeys,
		PrivateKey:      keys["party-1"],
	}
	coord, err := NewCeremonyCoordinator(cfg)
	require.NoError(t, err)
	logger := &capturingAuditLogger{}
	coord.WithAuditLogger(logger)

	// Put the coordinator into COMMIT phase with a session; inject party-1's commit
	// only — party-2 and party-3 are silent (will time out).
	sessionID := "timeout-session"
	coord.mu.Lock()
	coord.sessionID = sessionID
	coord.currentPhase = PhaseCommit
	coord.receivedCommits["party-1"] = &CeremonyMessage{SenderID: "party-1"}
	coord.mu.Unlock()

	// waitForPhase needs 3 commits; only 1 is present → should time out.
	err = coord.waitForPhase(PhaseCommit, 3)
	require.Error(t, err, "waitForPhase must return an error on timeout")
	assert.Contains(t, err.Error(), "timeout")

	assert.Equal(t, PhaseFailed, coord.GetCurrentPhase(),
		"phase must transition to FAILED after timeout")

	failed := coord.GetFailedParticipants()
	assert.Len(t, failed, 2, "two parties did not respond")
	assert.Contains(t, failed, "party-2")
	assert.Contains(t, failed, "party-3")

	assert.True(t, logger.HasEventType(AuditTimeout),
		"TIMEOUT audit event must be emitted")
}

// TestUnknownParticipant_MessageRejected verifies that a message from an ID
// not in ParticipantKeys is rejected before any state is modified.
func TestUnknownParticipant_MessageRejected(t *testing.T) {
	keys := map[string]*secp256k1.PrivateKey{
		"party-1": genKey(t),
		"party-2": genKey(t),
	}
	pubKeys := participantSet(keys)

	coord, logger := newTestCoordinator(t, "party-1", keys["party-1"], pubKeys)

	sessionID := "unknown-session"
	coord.mu.Lock()
	coord.sessionID = sessionID
	coord.currentPhase = PhaseCommit
	coord.mu.Unlock()

	// Generate a key for an unknown party and sign the message with it
	unknownKey := genKey(t)
	msg := &CeremonyMessage{
		Type:      KeyGenCeremony,
		Phase:     PhaseCommit,
		SessionID: sessionID,
		SenderID:  "party-unknown",
		Payload:   mustMarshal(KeyGenCommitPayload{PartyID: "party-unknown", Commitment: []byte("x")}),
		Timestamp: time.Now().Unix(),
	}
	require.NoError(t, SignMessage(msg, unknownKey))

	err := coord.HandleMessage(msg)
	require.Error(t, err, "message from unknown participant must be rejected")
	assert.Contains(t, err.Error(), "unknown participant",
		"error should name the unknown participant")

	assert.True(t, logger.HasEventType(AuditMessageRejected))

	coord.mu.RLock()
	defer coord.mu.RUnlock()
	assert.Empty(t, coord.receivedCommits,
		"message from unknown participant must not be stored")
}

// TestTamperedPayload_PayloadHashMismatchRejected verifies that a message whose
// payload was altered after signing is caught by the payload-hash check.
func TestTamperedPayload_PayloadHashMismatchRejected(t *testing.T) {
	keys := map[string]*secp256k1.PrivateKey{
		"party-1": genKey(t),
		"party-2": genKey(t),
	}
	pubKeys := participantSet(keys)

	coord, _ := newTestCoordinator(t, "party-1", keys["party-1"], pubKeys)

	sessionID := "tamper-session"
	coord.mu.Lock()
	coord.sessionID = sessionID
	coord.currentPhase = PhaseCommit
	coord.mu.Unlock()

	msg := buildCommitMsg(t, keys["party-2"], "party-2", sessionID)

	// Tamper the payload after signing; PayloadHash no longer matches
	msg.Payload = mustMarshal(KeyGenCommitPayload{PartyID: "party-2", Commitment: []byte("tampered")})

	err := coord.HandleMessage(msg)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "payload hash",
		"error should indicate payload hash mismatch")
}

// TestAuditEvents_PhaseStartEmitted verifies that a PHASE_START event is
// emitted when waitForPhase is called.
func TestAuditEvents_PhaseStartEmitted(t *testing.T) {
	keys := map[string]*secp256k1.PrivateKey{
		"party-1": genKey(t),
	}
	pubKeys := participantSet(keys)

	cfg := &CeremonyConfig{
		Threshold:       1,
		TotalParties:    1,
		PartyID:         "party-1",
		Timeout:         50 * time.Millisecond,
		ParticipantKeys: pubKeys,
		PrivateKey:      keys["party-1"],
	}
	coord, err := NewCeremonyCoordinator(cfg)
	require.NoError(t, err)
	logger := &capturingAuditLogger{}
	coord.WithAuditLogger(logger)

	sessionID := "audit-session"
	coord.mu.Lock()
	coord.sessionID = sessionID
	coord.currentPhase = PhaseCommit
	// Pre-populate the single required commit so waitForPhase returns immediately
	coord.receivedCommits["party-1"] = &CeremonyMessage{SenderID: "party-1"}
	coord.mu.Unlock()

	err = coord.waitForPhase(PhaseCommit, 1)
	require.NoError(t, err)

	assert.True(t, logger.HasEventType(AuditPhaseStart),
		"PHASE_START audit event must be emitted at the start of waitForPhase")
}
