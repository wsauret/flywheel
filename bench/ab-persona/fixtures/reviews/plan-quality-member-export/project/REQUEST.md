# Request: nightly member export to the federation

From the club secretary.

The regional federation needs our member list to insure our riders. Today the secretary uploads a spreadsheet by hand every month.

1. Every night, upload a CSV of the members who were created or changed since the last successful export. The first export sends every member.
2. Columns, in this order: `member_id`, `name`, `membership_type`, `status`.
3. Status changes must reach the federation: when the payment sync marks a member `lapsed` or `cancelled`, the next export carries that member, so the federation stops insuring them.
4. When an upload fails, the next night's export must still include every change the failed upload carried.
