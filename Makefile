.PHONY: all build run clean test

# Build the webserver
build:
	@echo "Copying public directory to internal/static..."
	@rm -rf internal/static/public
	@cp -r public internal/static/
	@echo "Building webserver..."
	@go build -o bin/webserver ./cmd/webserver
	@echo "Build complete: bin/webserver"

# Run the webserver
run: build
	@echo "Starting webserver on port 8080..."
	@./bin/webserver

# Clean build artifacts
clean:
	@echo "Cleaning build artifacts..."
	@rm -rf bin/
	@rm -rf internal/static/public
	@echo "Clean complete"

# Run tests
test:
	@go test ./...

# Build and run with custom port
run-dev: build
	@echo "Starting webserver on port 3000 with hot reload..."
	@./bin/webserver -port 3000 -data ./data-dev

# Install dependencies
deps:
	@go mod download
	@go mod tidy

all: clean build
