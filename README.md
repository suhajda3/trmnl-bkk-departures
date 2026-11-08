# BKK Departures

A [TRMNL](https://trmnl.com) plugin for ePaper displays, connected by
[GitHub Sync](https://help.trmnl.com/en/articles/15977899-github-sync): every save in TRMNL lands here as a commit.

<img width="150" alt="image" src="https://trmnl.com/images/brand/badges/light/works-with-trmnl/trmnl-badge-works-with-light.svg" />

### Develop locally

Templates and settings live in [`src/`](src/), ready for [trmnlp](https://github.com/usetrmnl/trmnlp):

```sh
gem install trmnl_preview
trmnlp serve
```

### Tests

Put RSpec files in `tests/` and run them with fake APIs, a fixed clock and every TRMNL device.
See [Testing plugins](https://github.com/usetrmnl/trmnlp#testing-plugins):

```sh
trmnlp test --report report
```

### Discoverability

Add the `trmnl` topic to this repo so other TRMNL plugin builders can find it.
