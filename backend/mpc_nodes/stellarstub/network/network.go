// Package network is a stub for github.com/stellar/go/network
package network

const TestNetworkPassphrase = "Test SDF Network ; September 2015"
const PublicNetworkPassphrase = "Public Global Stellar Network ; September 2015"

func HashTransaction(tx interface{}, networkPassphrase string) ([32]byte, error) {
	return [32]byte{}, nil
}
