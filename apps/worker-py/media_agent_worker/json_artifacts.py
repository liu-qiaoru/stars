"""Small safety helpers shared by local evaluation JSON commands.

Evaluation artifacts are audit evidence. Writers therefore reject input/output path
collisions and replace outputs atomically, so a typo or interrupted process cannot
silently destroy the packet or a human annotation export.
"""

import json
import os
from pathlib import Path
import tempfile


def ensure_distinct_output_path(output_path, input_paths):
    """Reject an output that resolves to any input path, including relative aliases."""
    resolved_output = output_path.resolve()
    for input_path in input_paths:
        if resolved_output == input_path.resolve():
            raise ValueError(f"Output must not overwrite an input file: {input_path}")


def read_json(path):
    """Read one UTF-8 JSON document while preserving parse errors for diagnosis."""
    with path.open("r", encoding="utf-8") as input_file:
        return json.load(input_file)


def write_json_atomically(value, output_path):
    """Replace an output only after a complete UTF-8 JSON document reaches disk."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output_file:
            json.dump(value, output_file, ensure_ascii=False, indent=2)
            output_file.write("\n")
        os.replace(temporary_name, output_path)
    except BaseException:
        Path(temporary_name).unlink(missing_ok=True)
        raise
