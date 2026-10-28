//go:build !unix

package main

import "os/exec"

// killGroupOnCancel: there are no process groups to signal here, so a timeout
// kills the started process only (exec's default) and WaitDelay bounds the wait.
func killGroupOnCancel(cmd *exec.Cmd) {}
