//go:build unix

package main

import (
	"os/exec"
	"syscall"
)

// killGroupOnCancel starts cmd in a process group of its own and makes the
// cancellation of its context kill the whole group. exec's default kills only
// the process it started, and the helpers git spawns (ssh, git-remote-https)
// outlive it, holding the output pipe and the connection.
func killGroupOnCancel(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
			return cmd.Process.Kill() // the group is gone or was never made: the process alone
		}
		return nil
	}
}
