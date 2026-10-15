"""Read a flow file's YAML in tests, where PyYAML has no constructor for yian's type tags."""

import yaml


class _Loader(yaml.SafeLoader):
    """A safe loader that reads a type-tagged scalar, such as ``!str`` or ``!int 5``, as its text."""


def _tagged(loader: _Loader, suffix: str, node: yaml.Node):
    if isinstance(node, yaml.ScalarNode):
        return f"!{suffix} {node.value}".rstrip()
    if isinstance(node, yaml.MappingNode):
        return loader.construct_mapping(node, deep=True)
    return loader.construct_sequence(node, deep=True)


_Loader.add_multi_constructor("!", _tagged)


def read_flow(text: str):
    """The flow YAML in ``text`` as plain data."""
    return yaml.load(text, Loader=_Loader)
