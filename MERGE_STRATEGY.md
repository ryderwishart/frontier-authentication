Constraints:

- need to use isomorphic git because we need to run it in the browser
- cannot merge() when there are conflicts because isomorphic git doesn't support it
- can merge without conflicts
- users can resolve conflicts in the client app if they have access to the conflicting file contents
- users can alert us that conflicts have been resolved by calling completeMerge()
- we need to ensure that the merge commit is created, it correctly merges the divergent history, and then it is pushed, so that the remote is not converged properly, and all consumers will be able to resolve.

What we want is:

1. consumer calls syncChanges from @syncChanges()
2. attempt sync
3. if conflict, then return the conflicting file paths WITH their content as a string (i.e., our content, and then theirs from a fetch - we don't need to start merging yet)
4. the consuming client gets the conflicts list back from FrontierAPI.syncChanges(), and then manually resolves conflicts using custom logic on the client side
5. once the repo is in a manually resolved state, the consuming client calls completeMerge() on the api, passing back a list of resolved file paths.
6. now, what we need to do is ensure that the merge commit is created, explains which files were resolved, and then it is pushed, so that the remote is not converged properly, and all consumers will be able to resolve.
