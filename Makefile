GO_DIR := mac-bridge-go
BRIDGE := $(GO_DIR)/bridge

.PHONY: test go-test go-race go-pure go-vet build run android-test android-build verify

test: go-test android-test

go-test:
	go -C $(GO_DIR) test ./...

go-race:
	go -C $(GO_DIR) test -race ./...

go-pure:
	CGO_ENABLED=0 go -C $(GO_DIR) test ./...

go-vet:
	go -C $(GO_DIR) vet ./...

build:
	go -C $(GO_DIR) build -o bridge ./cmd/bridge

run: build
	./$(BRIDGE)

android-test:
	./scripts/with-local-env.sh ./glasses-app/gradlew -p glasses-app testDebugUnitTest

android-build:
	./scripts/with-local-env.sh ./glasses-app/gradlew -p glasses-app assembleDebug

verify: go-race go-pure go-vet build android-test android-build
