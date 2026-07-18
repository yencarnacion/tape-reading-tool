#!/bin/bash

# yamir@azul tape-reading-tool % ./go.sh download -provider massive -symbol IONQ -start "$(date +%F) 04:00:00"  -end "$(date +%F) 20:00:00"

./go.sh replay -symbol IONQ -provider massive -source historical
