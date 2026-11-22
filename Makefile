export PATH := $(CURDIR)/node_modules/.bin:$(PATH)

ci: install lint typecheck test

install:
	npm ci

lint:
	eslint "src/**/*.ts" "test/**/*.ts" --max-warnings=0

lint-fix:
	eslint "src/**/*.ts" "test/**/*.ts" --fix

typecheck:
	tsc --noEmit

build:
	tsc -p tsconfig.build.json

test:
	NODE_OPTIONS=--experimental-vm-modules jest --coverage

prettier:
	prettier --write .

check:
	prettier --check .

badge: test
	coverage-badges

publish:
	npm publish --access public

.PHONY: ci install lint lint-fix typecheck build test prettier check badge publish
