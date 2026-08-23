# chan-post-store

`chan-post-store` in an image board archive aggregation framework that lets you combine and analyze multiple datasets.

### Features

- Store + process data locally or on a more capable remote server
- Postgres text search indexing for fast keyword search

## Add custom sources

## Setup

### Prerequisites

- A postgres server running somewhere
- A storage server that you can access over ssh (optional)

### Install

After you've cloned the project and have a terminal open at its root:

1. `cp .env.example .env`
1. `nix develop`
1. `npm install`

This setups up the absolute bare minimum for the cli to run. You'll need to set your storage location and env vars

### Storage

`chan-post-store` supports two storage modes.

#### Local storage

To run `chan-post-store` using local storage:

1. Open `./chan.config.json` and set `storage.type` to `"local"`
1. Set `STORAGE_ROOT` in `.env `to the location where archive sources should get saved

#### Remote storage

To run `chan-post-store` with a remote storage server:

1. Open `./chan.config.json` and set `storage.type` to `"remote"`
1. Set `NAS_ROOT` in `.env `to the location where archive sources should get saved
1. Generate a key `ssh-keygen -t ed25519 -f ~/.ssh/id_4chan_nas -N ''`
   - **SECURITY NOTE**: This configuration has no password so its only suitable for home networks
1. `ssh-copy-id -i ~/.ssh/id_4chan_nas.pub <user>@<host>` Copy the key to your storage server
1. Set `NAS_HOST`, `NAS_USER` to the host address and username of your storage server
1. Make sure `NAS_KEY` points to the correct ssh key (if you use the commands above the default `~/.ssh/id_4chan_nas` should work)

### DB configuration

1. Update `.env` to match the configuration of you Postgres server, the variable names `.env.example` are self explanatory

## Usage

### Managing sources

You can list check what sources are available using

```sh
npm run cli list manifests
```

#### Source Availability

Sources can be entirely ignored with by omitting them from the `"sources"` array inside `./chan.config.json`.
The values inside `"sources": []` correspond to directory names in `./sources` (no trailing slash).

## TODO

- [ ] Think of a better name
