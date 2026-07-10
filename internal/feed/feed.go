package feed

import "context"

type Feed interface {
	Run(context.Context)
	SetSymbol(string)
}
