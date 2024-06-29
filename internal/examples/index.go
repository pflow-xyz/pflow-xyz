package examples

import "github.com/pflow-dev/pflow-xyz/protocol/model"

var (
	ExampleModels = map[string]*model.Model{
		"DiningPhilosophers": model.FromZblob(&DiningPhilosophers),
		"InhibitorTest":      InhibitorTest,
		"TicTacToe":          model.FromZblob(&TicTacToe),
	}
)
