package vasm

import . "github.com/pflow-dev/pflow-xyz/protocol/metamodel"
import "fmt"

type StateMachine struct {
	m        *PetriNet
	state    Vector
	capacity Vector
}

func (sm *StateMachine) TestFire(op Op) (flag bool, msg string, out Vector) {
	txn := sm.m.Transitions[op.Action]
	if txn == nil {
		return false, UnknownAction, sm.GetState()
	}
	if op.Role != "" && txn.Role.Label != op.Role {
		return false, FailedRoleAssertion, sm.GetState()
	}
	if op.Multiple < 0 {
		return false, BadMultiple, sm.GetState()
	} else if op.Multiple == 0 {
		op.Multiple = 1
	}
	isInhibited, label := sm.Inhibited(op)
	if isInhibited {
		return false, fmt.Sprintf(InhibitedTransition, label), out
	}
	flag, msg, out = Add(sm.state, txn.Delta, op.Multiple, sm.capacity)
	if !flag {
		return false, msg, out
	}
	return true, OK, out // REVIEW: match lua implementation to return Role
}

func (sm *StateMachine) Fire(op Op) (ok bool, msg string, out Vector) {
	// TODO: refactor to support wf-nets and elementary modelTypes
	ok, msg, out = sm.TestFire(op)
	if ok {
		for i, v := range out {
			sm.state[i] = v
		}
	}
	return ok, msg, out
}

func (sm *StateMachine) Inhibited(op Op) (inhibited bool, msg string) {
	tx := sm.m.Transitions[op.Action]
	if tx == nil {
		panic(UnknownAction)
	}
	for _, g := range tx.Guards {
		flag, _, _ := Add(sm.state, g.Delta, 1, sm.m.EmptyVector())
		if g.Inverted {
			if !flag {
				return true, g.Label
			}
		} else {
			if flag {
				return true, g.Label
			}
		}
	}
	return false, msg
}

func (sm *StateMachine) GetState() Vector {
	s := make([]int64, len(sm.state))
	copy(s, sm.state)
	return s
}

func (sm *StateMachine) TokenCount(label string) int64 {
	p := sm.m.Places[label]
	if p == nil {
		panic(ExpectedPlace)
	}
	return sm.state[p.Offset]
}

// Execute run the m
func Execute(m *PetriNet, initialVec ...Vector) Process {

	sm := new(StateMachine)
	sm.m = m
	switch len(initialVec) {
	case 0:
		sm.state = m.InitialVector()
		sm.capacity = m.CapacityVector()
	case 1:
		sm.state = initialVec[0]
		sm.capacity = m.CapacityVector()
	case 2:
		sm.state = initialVec[0]
		sm.capacity = initialVec[1]
	default:
		panic(fmt.Sprintf(UnexpectedArguments, 2, len(initialVec)))
	}
	if len(sm.state) == 0 {
		sm.state = m.InitialVector()
	} else if len(sm.state) != len(sm.capacity) {
		sm.state = m.EmptyVector()
	}
	return sm
}
