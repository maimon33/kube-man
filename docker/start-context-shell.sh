#!/usr/bin/env bash
set -u

requested_context="${1:-}"
source_config="$HOME/.kube/config"
working_dir="$HOME/.kubeman"
working_config="$working_dir/kubeconfig"

mkdir -p "$working_dir"
chmod 700 "$working_dir"

if [[ -f "$source_config" ]]; then
  temp_config="$working_dir/kubeconfig.new"
  cp "$source_config" "$temp_config"
  chmod 600 "$temp_config"
  mv "$temp_config" "$working_config"
fi

export KUBECONFIG="$working_config"

if [[ -n "$requested_context" && "$requested_context" =~ ^[A-Za-z0-9._:@/-]+$ ]] \
  && kubectl config get-contexts -o name 2>/dev/null | grep -Fqx -- "$requested_context"; then
  kubectl config use-context "$requested_context" >/dev/null 2>&1
  export KUBEMAN_CONTEXT="$requested_context"
else
  current_context="$(kubectl config current-context 2>/dev/null || true)"
  export KUBEMAN_CONTEXT="${current_context:-$requested_context}"
  if [[ -n "$requested_context" && "$requested_context" != "${current_context:-}" ]]; then
    printf '\033[38;5;214mKubeMan: context "%s" is not in the mounted kubeconfig; using "%s".\033[0m\n' \
      "$requested_context" "${current_context:-no-context}"
  fi
fi

exec bash --rcfile /home/operator/.bashrc -i
