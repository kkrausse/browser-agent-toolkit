import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from inventory import Item, low_stock, total_value


class InventoryTest(unittest.TestCase):
    def setUp(self):
        self.items = [Item("rice", 4, 2.5), Item("beans", 2, 1.2), Item("salt", 1, 0.8)]

    def test_total_value(self):
        self.assertAlmostEqual(total_value(self.items), 13.2)

    def test_low_stock(self):
        self.assertEqual([item.name for item in low_stock(self.items)], ["beans", "salt"])


if __name__ == "__main__":
    unittest.main()
