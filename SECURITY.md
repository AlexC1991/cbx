# Reporting a security problem

Email **security@coderook.com** rather than opening a public issue.

Say what you found, how to reproduce it, and which version (`cbx --version`).
You will get a reply, and a fix will be released before the problem is
described publicly. Please give us a reasonable time to do that.

Things we especially want to hear about:

- a stored tree or a server that can make CBX write outside the project
  folder, or into `.git` or `.cbx`;
- a way for damaged or substituted objects to reach a folder without being
  caught by the digest checks;
- a restore, switch, merge or pull that loses a change it should have refused
  to overwrite.
