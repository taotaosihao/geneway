FROM node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c

ARG GENEWAY_PARSER_PACKAGE_DIGEST
LABEL org.geneway.parser.name="geneway-plain-text-parser" \
      org.geneway.parser.version="1.0.0" \
      org.geneway.parser.package-digest="${GENEWAY_PARSER_PACKAGE_DIGEST}" \
      org.geneway.parser.base-digest="sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c"

COPY --chmod=0555 plain-text-parser.mjs /opt/geneway-parser/plain-text-parser.mjs
USER 65534:65534
ENTRYPOINT ["node","--permission","--allow-fs-read=/input/source","--allow-fs-read=/opt/geneway-parser/plain-text-parser.mjs","--allow-fs-write=/output/canonical.bin","--no-addons","/opt/geneway-parser/plain-text-parser.mjs"]
