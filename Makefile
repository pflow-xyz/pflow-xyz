.PHONY: build
build: webui-build public-setup rice-setup go-build

.PHONY: webui-build
webui-build:
	pushd ./webui/ && npm run build && popd

.PHONY: public-setup
public-setup:
	rm -rf ./public
	mv ./webui/build ./public

.PHONY: rice-setup
rice-setup:
	if [ -x `which rice` ]; then \
		echo "found rice: `which rice`"; \
	else \
		echo "installing rice"; \
		go install github.com/GeertJohan/go.rice/rice@latest; \
	fi
	rice embed-go

.PHONY: go-build
go-build:
	$(eval MAIN_JS := $(shell basename `ls public/static/js/main.*.js`))
	$(eval MAIN_CSS := $(shell basename `ls public/static/css/main.*.css`))
	$(eval JS := $(shell echo $(MAIN_JS) | cut -d'.' -f2))
	$(eval CSS := $(shell echo $(MAIN_CSS) | cut -d'.' -f2))
	@echo "FIXME: Set Webui Version: main.$(JS).js main.$(CSS).css"
	go build -ldflags "-X 'github.com/pflow-dev/pflow-xyz/config.cssBuild=$(CSS)' -X 'github.com/pflow-dev/pflow-xyz/config.jsBuild=$(JS)' -s -w" -o pflow-xyz main.go
