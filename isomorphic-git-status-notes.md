# Notes

## A file exists locally but not on remote

["files/target/TheChosen_101_en.codex",1,1,1],
["files/target/TheChosen_101_en.codex",1,1,1],
["files/target/TheChosen_101_en.codex",0,2,2],
["files/target/TheChosen_101_en.codex",0,2,2],

### File is added locally, but not pushed up yet (before and after commit)

workingCopyStatusBeforeCommit
["files/target/FILE_ADDED_LOCALLY.codex",0,2,0],
localStatusMatrix
["files/target/FILE_ADDED_LOCALLY.codex",1,1,1],
mergeBaseStatusMatrix
["files/target/FILE_ADDED_LOCALLY.codex",0,2,2],
remoteStatusMatrix
["files/target/FILE_ADDED_LOCALLY.codex",0,2,2],

## A file exists (is added) on remote but not locally

remoteStatusMatrix has:
["files/target/TheChosen_101_en.codex",1,0,0],

but file is not in localStatusMatrix at all

[Extension Host] workingCopyStatusBeforeCommit:
["files/target/TheChosen_101_en.codex",1,1,1],

[Extension Host] localStatusMatrix:
["files/target/TheChosen_101_en.codex",1,1,1],

[Extension Host] mergeBaseStatusMatrix:
["files/target/TheChosen_101_en.codex",1,1,1],

[Extension Host] remoteStatusMatrix:
["files/target/TheChosen_101_en.codex",1,1,1],
["files/target/TheChosen_103_en.codex",1,0,0],

## A file is deleted locally

Status before committing local changes: [".project/sourceTexts/TheChosen_105_ta_syncfix.source",1,0,1]

## A file is deleted on remote

workingCopyStatusBeforeCommit:
[".project/sourceTexts/TheChosen_105_ta_syncfix.source",1,1,1],
localStatusMatrix:
[".project/sourceTexts/TheChosen_105_ta_syncfix.source",1,1,1],
mergeBaseStatusMatrix:
[".project/sourceTexts/TheChosen_105_ta_syncfix.source",1,1,1],
remoteStatusMatrix:
[".project/sourceTexts/TheChosen_105_ta_syncfix.source",0,2,2],

# Status matrix entries with changes:

## When there is a change on the remote branch

Local changes:
['.vscode/settings.json', 1, 2, 1]

Remote changes:
['.vscode/settings.json', 1, 2, 1]
['files/smart_edits.json', 1, 2, 2]
['files/target/1JN.codex', 1, 2, 2]

## When I make a change locally to a file

Status before committing local changes:
["files/target/1JN.codex", 1, 2, 1]
present on local head; WORKDIR is different from local head,

Working copy is dirty
Staging and committing local changes
Fetching remote changes

Status after committing local changes:
[]

Status of remote HEAD:
["files/target/1JN.codex", 1, 2, 2]

## When both local and remote have changes to the same file

Status before committing local changes:
["files/target/1JN.codex", 1, 2, 1]

Status after committing local changes:
[]

Status of remote HEAD:
["files/ice_edits.json", 1, 2, 2]
["files/smart_edits.json", 1, 2, 2]
["files/target/1JN.codex", 1, 2, 2]

## General examples

The HEAD status is either absent (0) or present (1).
The WORKDIR status is either absent (0), identical to HEAD (1), or different from HEAD (2).
The STAGE status is either absent (0), identical to HEAD (1), identical to WORKDIR (2), or different from WORKDIR (3).

```
[
  ["a.txt", 0, 2, 0], // new, untracked
  ["b.txt", 0, 2, 2], // added, staged
  ["c.txt", 0, 2, 3], // added, staged, with unstaged changes
  ["d.txt", 1, 1, 1], // unmodified
  ["e.txt", 1, 2, 1], // modified, unstaged
  ["1JN.codex", 1, 2, 2], // modified, staged
  ["1JN.codex", this file is presentOnRemote, this workingDir file is differentFromRemoteHead, this file is identical to working directory - not remote HEAD], // modified, staged


  ["g.txt", 1, 2, 3], // modified, staged, with unstaged changes
  ["h.txt", 1, 0, 1], // deleted, unstaged
  ["i.txt", 1, 0, 0], // deleted, staged
  ["j.txt", 1, 2, 0], // deleted, staged, with unstaged-modified changes (new file of the same name)
  ["k.txt", 1, 1, 0], // deleted, staged, with unstaged changes (new file of the same name)
]
```
