import unittest

from download_swe_bench import select


class SelectionTests(unittest.TestCase):
    def test_repo_coverage_lengths_ties_and_order_independence(self):
        rows = [
            {"instance_id": "a1", "repo": "a", "problem_statement": "aa"},
            {"instance_id": "a2", "repo": "a", "problem_statement": "bb"},
            {"instance_id": "a3", "repo": "a", "problem_statement": "x"},
            {"instance_id": "b1", "repo": "b", "problem_statement": "éé"},
        ]
        self.assertEqual([row["instance_id"] for row in select(rows, 3)], ["a1", "a2", "b1"])
        self.assertEqual(select(rows, 3), select(list(reversed(rows)), 3))
        self.assertEqual([row["instance_id"] for row in select(rows, 2)], ["a1", "b1"])

    def test_insufficient_count_rejected(self):
        with self.assertRaises(ValueError):
            select([{"instance_id": "a", "repo": "a", "problem_statement": "x"}], 0)


if __name__ == "__main__":
    unittest.main()
