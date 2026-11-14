package vault

import (
	"strings"
	"testing"
)

func TestEncryptDecrypt(t *testing.T) {
	key := strings.Repeat("ab", 32)
	value, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	encrypted, err := value.Encrypt("token-secreto", []byte("123456789012"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(encrypted, "token-secreto") {
		t.Fatal("el texto plano aparece en el cifrado")
	}
	decrypted, err := value.Decrypt(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if decrypted != "token-secreto" {
		t.Fatalf("decrypt = %q", decrypted)
	}
}

func TestDecryptInvalid(t *testing.T) {
	value, err := New(strings.Repeat("00", 32))
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []string{"", "a.b", "a.b.c", "!!!.@@@.###"} {
		if _, err := value.Decrypt(input); err == nil {
			t.Fatalf("aceptó %q", input)
		}
	}
}

func TestNewInvalidKey(t *testing.T) {
	for _, key := range []string{"", "abc", strings.Repeat("zz", 32)} {
		if _, err := New(key); err == nil {
			t.Fatalf("aceptó clave %q", key)
		}
	}
}
