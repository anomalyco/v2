# create-sst

**Important:** This is only for older SST v2 apps. For SST v3, use the [`sst init`](https://sst.dev/docs/reference/cli#init) CLI.

---

A simple CLI [`create-sst`](https://www.npmjs.com/package/create-sst) that sets up a modern web application powered by SST

## Usage

There's no need install this CLI. Just use it directly to create your projects.

With npx.

```bash
npx create-sst@two
```

Or with npm 6+

```bash
npm init sst
```

Or with Yarn 0.25+

```bash
yarn create sst@two
```

Or with PNPM 

```bash
pnpm create sst@two
```

This will prompt you for a folder name and bootstrap the application in that directory.

## Options

Pass in the following (optional) options.

### `--template`

Instead of the standard starter, you can choose to use one of our minimal setups or examples as the template to bootstrap.

```bash
npx create-sst@two --template=other/go
```

---

## Arguments

### `<destination>`

Specify a project name, instead of typing it into the interactive prompt.


```bash
npx create-sst@two my-sst-app
```

For more details, [head over to our docs](https://v2.sst.dev).

---

**Join our community** [Discord](https://sst.dev/discord) | [YouTube](https://www.youtube.com/c/sst-dev) | [Twitter](https://twitter.com/SST_dev)
