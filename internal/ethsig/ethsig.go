package ethsig

import (
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// This package provides utility helpers to sign and verify sealed JSON-LD canonical bytes
// using Ethereum-style secp256k1 signatures (keccak256 + secp256k1).
//
// Conventions used here:
// - canonicalBytes are the URDNA2015 N-Quads bytes produced by the sealing pipeline.
// - Two signing/verification modes are supported:
//   1) Raw signing: sign keccak256(canonicalBytes) directly.
//   2) personal_sign mode (EIP-191): sign keccak256("\x19Ethereum Signed Message:\n{len}" || canonicalBytes).
// - Signatures are encoded as 65-byte (r||s||v) and returned/accepted as 0x-prefixed hex.
// - v is normalized to 27/28 when returned by SignCanonicalWithPrivKey (to match wallet conventions).
//   When verifying, we accept v in either 27/28 or 0/1 formats.
//
// Typical usage:
//   sigHex, err := SignCanonicalWithPrivKey(canonicalBytes, "0x<privkeyhex>")
//   ok, err := VerifyEthereumSignature(canonicalBytes, sigHex, "0x...address", usePersonalSign)
//
// Note: This code assumes control over the signing format. If users sign with browser wallets
// (MetaMask), they commonly use personal_sign; set usePersonalSign=true when verifying those signatures.

// ErrInvalidSignatureLength is returned when the decoded signature is not 65 bytes.
var ErrInvalidSignatureLength = errors.New("signature must be 65 bytes (r||s||v)")

// HashKeccak256 computes keccak256 hash of the input.
func HashKeccak256(data []byte) []byte {
	return crypto.Keccak256(data)
}

// PersonalSignHash returns the keccak256 hash of the prefixed message according to
// the personal_sign / EIP-191 scheme used by many wallets:
//   keccak256("\x19Ethereum Signed Message:\n{len(message)}" || message)
func PersonalSignHash(message []byte) []byte {
	prefix := []byte("\x19Ethereum Signed Message:\n")
	lenStr := []byte(strconv.Itoa(len(message)))
	prefixed := make([]byte, 0, len(prefix)+len(lenStr)+len(message))
	prefixed = append(prefixed, prefix...)
	prefixed = append(prefixed, lenStr...)
	prefixed = append(prefixed, message...)
	return crypto.Keccak256(prefixed)
}

// PreparePersonalSignPayload returns the 0x-prefixed hex payload suitable to pass to a wallet's
// personal_sign method. Many wallets accept the message as a hex string representing UTF-8 bytes.
func PreparePersonalSignPayload(canonical []byte) string {
	return "0x" + hex.EncodeToString(canonical)
}

// SignCanonicalWithPrivKey signs canonicalBytes using a hex-encoded private key (0x... or raw hex).
// It signs keccak256(canonicalBytes) directly (RAW mode) and returns a 0x-prefixed hex signature
// in the common Ethereum format r||s||v (v returned as 27 or 28).
func SignCanonicalWithPrivKey(canonicalBytes []byte, privKeyHex string) (string, error) {
	privKeyHex = strings.TrimPrefix(privKeyHex, "0x")
	priv, err := crypto.HexToECDSA(privKeyHex)
	if err != nil {
		return "", fmt.Errorf("invalid private key: %w", err)
	}
	hash := HashKeccak256(canonicalBytes)

	sig, err := crypto.Sign(hash, priv)
	if err != nil {
		return "", fmt.Errorf("sign failed: %w", err)
	}
	// crypto.Sign returns V as 0 or 1; convert to 27/28 for wallet-style representation
	if sig[64] < 27 {
		sig[64] += 27
	}
	return "0x" + hex.EncodeToString(sig), nil
}

// SignPersonalWithPrivKey signs using the personal_sign prefixed hash (EIP-191 style).
// Returns 0x-prefixed hex signature r||s||v (v == 27/28).
func SignPersonalWithPrivKey(canonicalBytes []byte, privKeyHex string) (string, error) {
	privKeyHex = strings.TrimPrefix(privKeyHex, "0x")
	priv, err := crypto.HexToECDSA(privKeyHex)
	if err != nil {
		return "", fmt.Errorf("invalid private key: %w", err)
	}
	hash := PersonalSignHash(canonicalBytes)

	sig, err := crypto.Sign(hash, priv)
	if err != nil {
		return "", fmt.Errorf("sign failed: %w", err)
	}
	if sig[64] < 27 {
		sig[64] += 27
	}
	return "0x" + hex.EncodeToString(sig), nil
}

// normalizeSignature ensures sig is 65 bytes and converts V to 0 or 1 as expected by go-ethereum's SigToPub.
// It returns a copy of the signature with normalized V.
func normalizeSignature(sig []byte) ([]byte, error) {
	if len(sig) != 65 {
		return nil, ErrInvalidSignatureLength
	}
	out := make([]byte, 65)
	copy(out, sig)
	v := out[64]
	// Accept v in {0,1,27,28}
	if v == 27 || v == 28 {
		out[64] = v - 27 // convert to 0 or 1
	} else if v == 0 || v == 1 {
		// already normalized
	} else {
		// Some libraries may return v as 31/32 etc but those are unsupported here.
		return nil, fmt.Errorf("unsupported v value in signature: %d", v)
	}
	return out, nil
}

// VerifyEthereumSignature verifies that sigHex is a valid signature over canonicalBytes by expectedAddr.
// If usePersonalSign is true, the verification uses the personal_sign prefix (EIP-191) hash.
// expectedAddr may be a checksummed or non-checksummed address (0x...), comparison is case-insensitive.
// Returns (true,nil) if signature is valid, (false,nil) if signature is well-formed but signer differs,
// or (false,error) if an error occurred during verification.
func VerifyEthereumSignature(canonicalBytes []byte, sigHex string, expectedAddr string, usePersonalSign bool) (bool, error) {
	sigHex = strings.TrimPrefix(sigHex, "0x")
	sigBytes, err := hex.DecodeString(sigHex)
	if err != nil {
		return false, fmt.Errorf("invalid signature hex: %w", err)
	}
	if len(sigBytes) != 65 {
		return false, ErrInvalidSignatureLength
	}
	var hash []byte
	if usePersonalSign {
		hash = PersonalSignHash(canonicalBytes)
	} else {
		hash = HashKeccak256(canonicalBytes)
	}

	normSig, err := normalizeSignature(sigBytes)
	if err != nil {
		return false, fmt.Errorf("normalize signature: %w", err)
	}

	pubkey, err := crypto.SigToPub(hash, normSig)
	if err != nil {
		return false, fmt.Errorf("recover pubkey: %w", err)
	}
	recoveredAddr := crypto.PubkeyToAddress(*pubkey)
	// Normalize expected address and compare
	if !common.IsHexAddress(expectedAddr) {
		return false, fmt.Errorf("expectedAddr is not a valid hex address: %s", expectedAddr)
	}
	exp := common.HexToAddress(expectedAddr)
	// Case-insensitive equality is safe via comparing bytes
	if bytesEqualFold(recoveredAddr.Bytes(), exp.Bytes()) {
		return true, nil
	}
	return false, nil
}

// RecoverAddressFromSignature recovers the Ethereum address that produced sigHex over canonicalBytes.
// If usePersonalSign is true, the personal_sign prefix is applied before recovery.
func RecoverAddressFromSignature(canonicalBytes []byte, sigHex string, usePersonalSign bool) (string, error) {
	sigHex = strings.TrimPrefix(sigHex, "0x")
	sigBytes, err := hex.DecodeString(sigHex)
	if err != nil {
		return "", fmt.Errorf("invalid signature hex: %w", err)
	}
	if len(sigBytes) != 65 {
		return "", ErrInvalidSignatureLength
	}
	var hash []byte
	if usePersonalSign {
		hash = PersonalSignHash(canonicalBytes)
	} else {
		hash = HashKeccak256(canonicalBytes)
	}

	normSig, err := normalizeSignature(sigBytes)
	if err != nil {
		return "", fmt.Errorf("normalize signature: %w", err)
	}

	pubkey, err := crypto.SigToPub(hash, normSig)
	if err != nil {
		return "", fmt.Errorf("recover pubkey: %w", err)
	}
	recoveredAddr := crypto.PubkeyToAddress(*pubkey)
	return recoveredAddr.Hex(), nil
}

// bytesEqualFold compares two byte slices for equality.
func bytesEqualFold(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		// byte-wise equality; addresses are strictly hex-decoded bytes, no case folding required
		if a[i] != b[i] {
			return false
		}
	}
	return true
}