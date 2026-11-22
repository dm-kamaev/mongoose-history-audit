ci: install lint typecheck test

install:
	npm ci

lint:
	npm run lint

typecheck:
	npm run typecheck

test:
	npm run test:cov

badge: test
	npx coverage-badges

publish:
	npm publish --access public

.PHONY: ci install lint typecheck test badge publish
