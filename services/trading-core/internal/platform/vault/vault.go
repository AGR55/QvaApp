// Package vault descifra secretos AES-256-GCM compatibles con src/vault.ts.
//
// El formato es iv_base64.tag_base64.data_base64. La clave es un hex de 32
// bytes (64 caracteres). No registra ni expone secretos.
package vault

import (
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
)

// Vault contiene la clave local de cifrado.
type Vault struct {
	key []byte
}

// New valida la clave hex de 32 bytes y crea el vault.
func New(hexKey string) (*Vault, error) {
	hexKey = strings.TrimSpace(hexKey)
	key, err := hex.DecodeString(hexKey)
	if err != nil || len(key) != 32 {
		return nil, fmt.Errorf("LOCAL_ENCRYPTION_KEY debe ser hex de 64 caracteres")
	}
	return &Vault{key: key}, nil
}

// Decrypt descifra un valor con el formato iv.tag.data.
func (v *Vault) Decrypt(value string) (string, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return "", fmt.Errorf("secreto cifrado inválido")
	}
	iv, err := base64.StdEncoding.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("IV cifrado inválido")
	}
	tag, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("tag cifrado inválido")
	}
	data, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return "", fmt.Errorf("datos cifrados inválidos")
	}

	block, err := aes.NewCipher(v.key)
	if err != nil {
		return "", fmt.Errorf("cifrado AES inválido")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("GCM inválido")
	}
	if len(iv) != gcm.NonceSize() {
		return "", fmt.Errorf("IV de tamaño inválido")
	}
	plaintext, err := gcm.Open(nil, iv, append(data, tag...), nil)
	if err != nil {
		return "", fmt.Errorf("no se pudo descifrar el secreto")
	}
	return string(plaintext), nil
}

// Encrypt se usa solo en pruebas para generar vectores compatibles.
func (v *Vault) Encrypt(plaintext string, iv []byte) (string, error) {
	block, err := aes.NewCipher(v.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(iv) != gcm.NonceSize() {
		return "", fmt.Errorf("IV de tamaño inválido")
	}
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	tagStart := len(sealed) - gcm.Overhead()
	return strings.Join([]string{
		base64.StdEncoding.EncodeToString(iv),
		base64.StdEncoding.EncodeToString(sealed[tagStart:]),
		base64.StdEncoding.EncodeToString(sealed[:tagStart]),
	}, "."), nil
}
