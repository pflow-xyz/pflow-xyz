package config

var ( // set at build time w/ ldflags
	JsBuild  = `a10e1719` // update to match ./public/p/static/js/main.<JsBuild>.js
	CssBuild = `fc875e4f` // update to match ./public/p/static/css/main.<CssBuild>.css
)

const (
	Banner = `
        _____.__                                          
_______/ ____\  |   ______  _  __  ___  ______.__.________
\____ \   __\|  |  /  _ \ \/ \/ /  \  \/  <   |  |\___   /
|  |_> >  |  |  |_(  <_> )     /    >    < \___  | /    / 
|   __/|__|  |____/\____/ \/\_/ /\ /__/\_ \/ ____|/_____ \
|__|                            \/       \/\/           \/
`
)
