"""Extract the locked Node archive without links or out-of-root members."""
import pathlib
import sys
import tarfile

archive, destination, expected_root = sys.argv[1:]
target = pathlib.Path(destination).resolve()
if target.exists():
    raise RuntimeError("Source destination already exists; use a new short build path")
with tarfile.open(archive, "r:xz") as source:
    members = source.getmembers()
    for member in members:
        name = pathlib.PurePosixPath(member.name)
        if (
            name.is_absolute()
            or ".." in name.parts
            or "\\" in member.name
            or not name.parts
            or name.parts[0] != expected_root
            or not (member.isfile() or member.isdir())
        ):
            raise RuntimeError(f"Unsafe archive member: {member.name}")
        member.name = str(pathlib.PurePosixPath(*name.parts[1:]))
    target.mkdir(parents=True)
    source.extractall(target, members=members, filter="data")
print(f"Extracted {len(members)} members into {target}")
