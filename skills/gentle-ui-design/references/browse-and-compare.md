# Browse and compare

## Choose a representation

The representation should expose the property that makes a choice possible.

| User need | Default | Why | Useful exception |
| --- | --- | --- | --- |
| Compare several attributes | Compact aligned rows or a table | Values remain in predictable positions | Use cards when records have genuinely different structures |
| Judge appearance | Previews with names and selection state | The visual is part of the decision | Rows can work when a small thumbnail is sufficient |
| Scan mixed summaries | Cards with a meaningful shared structure | Each record can carry a short explanation and action | Do not wrap every field in its own card |

Keep identifying text, important status, and the selection or detail action visible.
Do not hide an essential attribute behind hover or require opening every record to compare it.
When compact rows become cramped on mobile, keep the identifier, most important value, and primary action visible;
move secondary fields into a readable second line or detail view, not an inaccessible horizontal strip.

## Search and filter without surprises

State what search covers when scope is not obvious: `Search titles and authors` is clearer than an unlabeled magnifying glass.
Distinguish a relevance-ranked result set from a date- or name-sorted list with a visible sort label.
Do not imply that a partial client-side subset is the entire catalog.
Where results can be filtered, put relevant controls next to the results, show a count when available, and expose active filters as removable chips or equivalent controls.
Provide a reset action when filters can prevent recovery.
On no results, retain the query and filters, explain that no matches were found, and offer a way to broaden or clear them.
An empty catalog is a different state: show how to add or obtain the first item when the user can do so.

## Choose how results are loaded

| Pattern | Good fit | Cost and required context |
| --- | --- | --- |
| Pagination | Comparing or returning to a known portion of results | Expose current page and navigation; restore the selected page on return |
| Load more | Sequential exploration when users may want to keep earlier results | Make loading explicit and retain the existing list; offer a way back to the prior position |
| Virtualized list | Many visible or loaded rows where rendering cost matters | Preserve keyboard access, focus, accessible item semantics, and a stable return position |
| Infinite scroll | A continuous feed where exact return positions matter less | Make restoration reliable and keep footer or other essential controls reachable; otherwise prefer explicit loading |

Bound the rendered items to what the interface can use; separately decide whether the data source should query and return only the needed subset.
Virtualizing a list can reduce rendered elements without reducing data transferred or backend work.
Use the actual architecture and measurements to choose; these patterns do not promise a particular performance result.
For planning, 10,000 entries is an illustrative scale, not a claim about a project or a mandatory fixture.

## Worked example: a large collection

Before: a supply catalog loads every item, draws a separate card for each one, hides unmatched cards after filtering,
and opens details without remembering the list. A user cannot tell which search fields were used or where they were on return.

After: search names its scope, a visible count and removable material filter describe the result set,
and compact rows align name, availability, and location. The server supplies a page of matching records when supported;
the interface renders that page and labels the current page and sort order. Opening a record retains the query and filters.
On return, restore the page, scroll position, and focus to the originating item when possible; if the item vanished, return focus to the results heading and explain the change.
This is a design for a hypothetical catalog, not a claim about its implementation or performance.

On a narrow screen, place search first, expose filters through a labeled control with an active-filter count,
and stack each row's secondary fields below its name. Keep availability and the detail action visible without hover.
Use a full table or persistent filter rail instead when the viewport and task genuinely support them.

## Preserve navigational context

Encode shareable query, filter, sort, and page state in the URL where the product supports it.
Browser back and a return from detail should recover the user's place rather than silently resetting the list.
Scroll and focus may be local history state rather than shareable URL parameters; restore both deliberately.
For changing datasets, handle missing pages or items honestly instead of presenting a stale count as current.
