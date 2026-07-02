// Package keypair is a stub for github.com/stellar/go/keypair
package keypair

// FromAddress is a stub for the Stellar keypair type
type FromAddress struct{ address string }

func MustParse(address string) *FromAddress { return &FromAddress{address: address} }
func (kp *FromAddress) Address() string     { return kp.address }
