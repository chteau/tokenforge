import unittest

from textutil.slug import slugify


class HiddenSlug(unittest.TestCase):
    def test_collapse_spaces_dashes(self):
        self.assertEqual(slugify("a  --  b"), "a-b")

    def test_collapse_punct(self):
        self.assertEqual(slugify("C++ & Rust!!"), "c-rust")

    def test_unchanged(self):
        self.assertEqual(slugify("Hello World"), "hello-world")
