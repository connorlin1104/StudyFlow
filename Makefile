.PHONY: serve deploy rules

# There is no build step and no backend: public/ is served as-is, and the browser
# talks to Firestore directly. Everything below is Firebase CLI shorthand.

# Serve public/ locally at http://localhost:5000, against the real Firestore.
serve:
	firebase emulators:start --only hosting

# Push the frontend plus the Firestore and Storage rules.
# Never run a bare `firebase deploy` — see README, this project has no Functions.
deploy:
	firebase deploy --only hosting,firestore:rules,storage

# Rules only — much faster when that's all that changed.
rules:
	firebase deploy --only firestore:rules,storage
