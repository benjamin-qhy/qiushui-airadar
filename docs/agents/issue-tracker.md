# Issue tracker: GitHub

Issues and specs live in GitHub Issues:
`benjamin-qhy/qiushui-airadar`

Use the `gh` CLI and explicitly include:
`--repo benjamin-qhy/qiushui-airadar`

## Common operations

- Create: `gh issue create --repo benjamin-qhy/qiushui-airadar`
- Read: `gh issue view <number> --comments --repo benjamin-qhy/qiushui-airadar`
- List: `gh issue list --repo benjamin-qhy/qiushui-airadar`
- Comment: `gh issue comment <number> --repo benjamin-qhy/qiushui-airadar`
- Label: `gh issue edit <number> --add-label "..." --repo benjamin-qhy/qiushui-airadar`
- Close: `gh issue close <number> --repo benjamin-qhy/qiushui-airadar`

## Pull requests as a triage surface

PRs as a request surface: no.

## Skill conventions

When a skill says "publish to the issue tracker", create a GitHub issue.
When a skill says "fetch the relevant ticket", read that GitHub issue.

For `/wayfinder`, use one `wayfinder:map` issue as the map and linked
sub-issues as child tickets. Use GitHub's native dependencies when available.
