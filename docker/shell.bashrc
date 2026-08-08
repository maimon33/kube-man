export HISTFILE="$HOME/.bash_history"
export HISTSIZE=10000
export HISTFILESIZE=20000
export HISTCONTROL=ignoreboth:erasedups
shopt -s histappend checkwinsize
PROMPT_COMMAND="history -a; history -n"

alias k="kubectl"
alias kgp="kubectl get pods"
alias kgs="kubectl get services"
alias h="helm"
alias ll="ls -alh --color=auto"

PS1='\[\e[38;5;149m\]\u@kubeman\[\e[0m\] \[\e[38;5;214m\][${KUBEMAN_CONTEXT:-no-context}]\[\e[0m\]:\[\e[38;5;80m\]\w\[\e[0m\]$ '

printf '\033[38;5;149mKubeMan live shell\033[0m  bash · kubectl · helm · aws · jq/yq\n'
printf '\033[38;5;244mCluster: %s · shell home persists · source Kubernetes and AWS config remain read-only.\033[0m\n\n' "${KUBEMAN_CONTEXT:-no-context}"
