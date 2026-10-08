import unittest

from textutil.slug import slugify


class SlugTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello World"), "hello-world")

    def test_trim(self):
        self.assertEqual(slugify("  Hi  "), "hi")


if __name__ == "__main__":
    unittest.main()
