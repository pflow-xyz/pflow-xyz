package config

var ( // set at buildtime w/ ldflags
	JsBuild  = `11172683` // update to match ./public/p/static/js/main.<JsBuild>.js
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
