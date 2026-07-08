import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from media_agent_worker.env import load_project_env


class EnvTest(unittest.TestCase):
    def test_load_project_env_reads_dotenv_without_overriding_existing_values(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            env_path.write_text(
                "DATABASE_URL=postgres://from-file\n"
                "QDRANT_URL=http://from-file:6333\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"DATABASE_URL": "postgres://from-shell"}, clear=True):
                loaded = load_project_env(env_path)

                self.assertTrue(loaded)
                self.assertEqual(os.environ["DATABASE_URL"], "postgres://from-shell")
                self.assertEqual(os.environ["QDRANT_URL"], "http://from-file:6333")


if __name__ == "__main__":
    unittest.main()
