Customers have noticed that some quotes created through the public HTTP API include an extra line item, code `RAS` ("Remote area surcharge"), worth 3.5% of the transport price. It only appears for certain destination postcodes, and not every customer gets it.

Find where this line item originates and explain the execution path for a quote request, starting from the entry point of the HTTP API process and ending where the quote is persisted. Include the steps that decide whether the surcharge applies, not just the arithmetic.

Write your answer to ANSWER.md in the repository root. List the execution path as a numbered list, one step per line, each starting with `path/to/file.ext:functionName` (path relative to the repository root), followed by a short explanation. After the list, briefly note any similarly named code that is NOT on this path.
