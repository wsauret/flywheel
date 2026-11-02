Hi @flameaway, it’s hard to tell what exactly is happening here without more info. Could you verify this issue occurs in both Requests 2.26.0 and urllib3 1.25.11?

It could very well be related to the ipaddress change, I’d just like to rule out other potential factors before we start down that path.
Requests 2.26.0 returns status 200. Either version of urllib (1.25.11, 1.26.7) work with it. Requests 2.27.0 returns the 407 error with either urllib version.
Thanks for confirming that! It sounds like this may be localized to today's release (2.27.0) We made some minor refactorings to how we handle proxies on redirects in https://github.com/psf/requests/pull/5924. I'm not seeing anything off immediately, so this will need some digging. For the meantime, using 2.26.0 is likely the short term solution.

I just want to clarify one more comment.

> When using proxies in python 3.8.12, I get an error 407. Using any other version of python works fine.

Does this mean 2.27.0 works on all other Python versions besides 3.8.12, or did you only test 2.27.0 with 3.8.12? I want to confirm we're not dealing with a requests release issue AND a python release issue.
> Does this mean 2.27.0 works on all other Python versions besides 3.8.12, or did you only test 2.27.0 with 3.8.12? I want to confirm we're not dealing with a requests release issue AND a python release issue.

It seems to only be having issues on 2.27.0. I didn't realize, but python 3.9.7 defaulted to installing requests 2.26.0. 
Confirming that this error also occurs with requests 2.27.0 and Python 3.8.9
To be clear, there is way too little information in here as it stands to be able to debug this from our end.
Did a bisect and found: 
```
ef59aa0227bf463f0ed3d752b26db9b3acc64afb is the first bad commit
commit ef59aa0227bf463f0ed3d752b26db9b3acc64afb
Author: Nate Prewitt <Nate.Prewitt@gmail.com>
Date:   Thu Aug 26 22:06:48 2021 -0700

    Move from urlparse to parse_url for prepending schemes

 requests/utils.py   | 21 +++++++++++++++------
 tests/test_utils.py |  1 +
 2 files changed, 16 insertions(+), 6 deletions(-)
```

I'm using a proxy from QuotaGuard, so it has auth.
So after doing some digging, in my case the params passed to `urlunparse` in `prepend_scheme_if_needed` went from:
scheme: `http`
netloc: `user:pwd@host:port`
To:
scheme: `http`
netloc: `host:port`
So the auth is lost from netloc here. The auth is still parsed and stored in the auth var, however.

Adding this to `prepend_scheme_if_needed` resolves, but unaware of any other issues that might cause:
```
if auth:
    netloc = '@'.join([auth, netloc])
```
Same issue here.
Since 2.27.0 with Python 3.8

I confirm @adamp01 investigation with mine. `user:pwd` seem to be lost during proxy parsing. I always get a 
`Tunnel connection failed: 407 Proxy Authentication Required`
Thanks for confirming @racam and @adamp01. We switched to using urllib3’s parser for proxies because of some recent changes to the standard lib `urlparse` around schemes. It looks like the two differ on their definition of `netloc`. I’m working on a patch to try to get this resolved.
Thank you for helping debug this @racam and @adamp01 