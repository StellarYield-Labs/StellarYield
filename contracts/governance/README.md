# Governance Threshold Preview Hashes

Threshold update proposals use a shared canonical encoding mirrored by:

- `client/src/pages/governance/thresholdPreviewHash.ts`
- `server/src/services/governance/thresholdPreviewHash.ts`

## Signer set hash

```
v1
<signer-address-1>
<signer-address-2>
...
```

Signers are trimmed, sorted lexicographically, and SHA-256 hashed.

## Payload hash

```
v1
<contract-id>
update_threshold
<threshold>
<signer-1>|<signer-2>|...
<proposer>
```

Changing signers or threshold changes the payload hash. Equivalent signer sets
produce identical preview hashes regardless of input order.
