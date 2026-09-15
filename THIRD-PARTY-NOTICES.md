# Third-party notices

This exporter's water and electricity clients are ports of code from two
other projects, credited here. Nothing is used unmodified: both clients were
rewritten for a standalone Prometheus exporter rather than a Homebridge
plugin, but the endpoint layouts, auth flows and hard-won edge cases they
encode came from this prior work.

## homebridge-read-your-meter-pro (water client)

`src/water/rympro-client.ts` is a direct port of `src/rympro.ts` from
[homebridge-read-your-meter-pro](https://github.com/Aransh/homebridge-read-your-meter-pro),
by the same author as this repository (MIT). That project's own
`THIRD-PARTY-NOTICES.md` documents where its understanding of the Read Your
Meter Pro portal API came from in turn:

> The endpoint layout used in `src/rympro.ts` — the base URL, the
> `/consumer/login`, `/consumer/me`, `/consumption/last-read`,
> `/consumption/forecast/{meter}`, `/consumption/{daily,monthly}/{meter}/{from}/{to}`
> paths, the `x-access-token` header, and the meaning of login error code 5060 —
> was derived from **pyrympro** by On Freund, used by the Home Assistant
> `rympro` integration.
>
> - Source: https://github.com/OnFreund/pyrympro
> - License: MIT

```
MIT License

Copyright (c) 2022 On Freund

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## homebridge-iec-electricity and py-iec-api (electricity client)

`src/electricity/iec-client.ts` is a port of `src/iec-client.ts` from
[homebridge-iec-electricity](https://github.com/shayshahar/homebridge-iec-electricity)
by Shay Shahar (Apache-2.0), itself a TypeScript port of
[py-iec-api](https://github.com/GuyKh/py-iec-api) by Guy Khmelnitsky
(Apache-2.0). The Okta PKCE/OTP login flow, the IEC endpoint layout, and the
`ReadingResolution` enum values (`DAILY=1`, `WEEKLY=2`, `MONTHLY=3`) all come
from that lineage; this port adds a `DAILY`-resolution fetch alongside the
`MONTHLY` one the source plugin used.

- homebridge-iec-electricity: https://github.com/shayshahar/homebridge-iec-electricity (Apache-2.0)
- py-iec-api: https://github.com/GuyKh/py-iec-api (Apache-2.0)

```
                                 Apache License
                           Version 2.0, January 2004
                        https://www.apache.org/licenses/

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       https://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

The full Apache-2.0 license text is available at
https://www.apache.org/licenses/LICENSE-2.0.txt.

## GuyKh/iec-custom-component

The Home Assistant IEC integration at
https://github.com/GuyKh/iec-custom-component (Apache-2.0) was consulted
(read only, no code copied) to confirm what resolution IEC's own API actually
supports — its code synthesizes hourly statistics from daily/monthly totals
rather than fetching real per-hour data, which is what informed this
exporter's decision not to claim more precision than the API can back up in
its time-of-use cost estimate. See `README.md`'s "Cost estimation" section.
