package config

var ( // set at buildtime w/ ldflags
	JsBuild  = `cd37c809` // update to match ./public/p/static/js/main.<JsBuild>.js
	CssBuild = `35f75858` // update to match ./public/p/static/css/main.<CssBuild>.css
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
