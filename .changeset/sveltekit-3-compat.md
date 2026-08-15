---
"svelte-kit-sst": patch
---

Support SvelteKit 3. `@sveltejs/kit/node/polyfills` was removed from SvelteKit 3's export map, so importing it made the Lambda handler fail to start with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The call was already a no-op on Node 20+, where `crypto` and `File` are globals, so it is safe to drop for SvelteKit 1 and 2 as well. Type-only imports also move from `@sveltejs/kit/types` to `@sveltejs/kit`, which resolves on every supported major.
