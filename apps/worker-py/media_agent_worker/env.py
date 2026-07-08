from pathlib import Path

from dotenv import load_dotenv


def project_root():
    return Path(__file__).resolve().parents[3]


def load_project_env(env_file=None):
    # Python entrypoints share the same root .env as the TypeScript server and Docker Compose.
    return load_dotenv(dotenv_path=env_file or project_root() / ".env", override=False)
