package main

import "strings"

func chatOrderRead() map[string]any {
	paths := make([]string, 0, 2)
	started := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		paths = append(paths, "https://api.qvapay.com/p2p/parent/chat?order=child")
		close(started)
		<-release
		close(done)
	}()
	<-started
	paths = append(paths, "https://api.qvapay.com/p2p/other/apply")
	close(release)
	<-done
	return map[string]any{"paths": paths}
}

func chatFailure(err error) *opError {
	message := err.Error()
	class := "error"
	if strings.Contains(message, "inválid") {
		class = "validation"
	}
	return &opError{Class: class, Message: message}
}
