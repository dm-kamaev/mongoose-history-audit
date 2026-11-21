publish:
	npm publish --access public

test:
	npm run test:cov

badge: test
	npx coverage-badges

.PHONY: test badge publish
