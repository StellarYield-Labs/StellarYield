package storage

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestStorageConfigRejectsUnsupportedBackend(t *testing.T) {
	cfg := &StorageConfig{Type: "filesystem", EncryptionKey: make([]byte, 32)}
	require.ErrorContains(t, cfg.Validate(), `unsupported storage type "filesystem"`)
}

func TestStorageConfigAcceptsSupportedBackends(t *testing.T) {
	for _, backend := range []string{"memory", "encrypted_file"} {
		t.Run(backend, func(t *testing.T) {
			cfg := &StorageConfig{Type: backend, EncryptionKey: make([]byte, 32)}
			require.NoError(t, cfg.Validate())
		})
	}
}
