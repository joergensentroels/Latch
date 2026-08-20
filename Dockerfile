# Latch: the credential boundary, in a container.
#
# NOT BUILT OR RUN YET. No container runtime exists on the machine this was written on
# (docker/podman/compose all absent, WSL has no distro), so everything below is reviewed and reasoned
# but unexercised. docker/README.md in the Bureau repo lists what to check on the first real build.
#
# There is no build stage and no package install, because Latch has ZERO runtime dependencies. That is
# worth stating rather than assuming: it means this image contains the Node base plus this repo's own
# source and nothing else -- no lockfile to audit, no transitive package that can change under it, no
# compiler or package manager left in the runtime layer. For the process that holds every credential in
# the system, that is the most valuable property in the file.
#
# Pinned by DIGEST, not by tag. `node:24-bookworm-slim` is mutable -- it moves on every upstream rebuild,
# so a tag makes "the image we reviewed" and "the image we run" different things without saying so. This
# digest was resolved from Docker Hub on 2026-08-20. Updating it is a deliberate act: re-resolve the tag,
# read what changed, change this line.
FROM node@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03

# Node 24 although package.json only requires >=22. Bureau needs >=24 for node:sqlite, and one base image
# across both services means one thing to re-pin and one CVE feed to watch instead of two.
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    HOSTS=0.0.0.0

WORKDIR /app

# Source only, owned by an account that cannot modify it. `node` (uid/gid 1000) ships with the official
# image; --chown at COPY time avoids a recursive chown layer that would double the image's size.
#
# The code is owned by root and run by node ON PURPOSE: a compromised Latch process cannot rewrite its
# own source. The one directory it may write is data/, created below.
COPY --chown=root:root . /app

# The single writable path. Latch writes only inside its data directory -- verified by reading every
# write call in server.js on 2026-08-20 -- which is what makes `read_only: true` viable for this service
# in compose. It is a mount point: the compose file puts a named volume here, so nothing persistent lives
# in the container's own layer.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

EXPOSE 8787

# A HEALTHCHECK THAT NEEDS NO CREDENTIAL. /api/health is unauthenticated by design, and that matters
# here beyond convenience: a healthcheck carrying a token would place that token in the image config,
# in `docker inspect` output, and in the process list of every health probe the daemon runs. The check
# is therefore deliberately shallow -- it proves the process is answering HTTP, not that it can decrypt
# anything -- and depth is left to the operator's own authenticated probes.
#
# node -e rather than curl: the slim base has no curl, and adding one would put a network client into
# the credential boundary's image to answer a question Node can already answer.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
