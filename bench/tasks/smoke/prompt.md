`slugify("a  --  b")` returns `"a------b"`. Runs of separators should collapse into a single dash, so it should return `"a-b"`. Fix it and run the tests.
