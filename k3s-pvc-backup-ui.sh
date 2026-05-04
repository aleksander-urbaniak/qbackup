#!/usr/bin/env bash

set -euo pipefail

APP_NAME="qbackup"
APP_LABEL_NAME="app.kubernetes.io/name"
APP_LABEL_COMPONENT="app.kubernetes.io/component"
APP_LABEL_VALUE="${APP_NAME}"

CONFIG_HOME_BASE="${XDG_CONFIG_HOME:-${HOME}/.config}"
CONFIG_DIR="${CONFIG_HOME_BASE}/${APP_NAME}"
CONFIG_FILE="${CONFIG_DIR}/config.env"
TMP_BASE="${TMPDIR:-/tmp}/${APP_NAME}"

KUBECTL_CONTEXT=""
CLUSTER_NAME="plvmck3scplc01"
NFS_SERVER="10.0.0.14"
NFS_EXPORT_PATH="/k3s-backup"
BACKUP_ROOT="pvc-backups"
HELPER_IMAGE="alpine:3.20"
DEFAULT_SCHEDULE="0 2 * * *"
RETENTION_DAYS="14"
KEEP_FAILED_PODS="false"
ARCHIVE_EXTENSION="tgz"
LOCAL_NFS_MOUNT_DIR="/mnt/k3s-backup"
LOCAL_NFS_PREFLIGHT="mount"
SCALE_CONSUMERS_FOR_BACKUP="true"

RUNTIME_COUNTER=0
LIVE_TAIL_PID=""
PROGRESS_PID=""
PROGRESS_FIFO=""
PROGRESS_FD=""
PROGRESS_ITEM_INDEX=0
PROGRESS_ITEM_TOTAL=0

trim() {
  local value="$1"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  printf '%s' "$value"
}

yaml_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "${value}"
}

init_runtime() {
  mkdir -p "${CONFIG_DIR}" "${TMP_BASE}"
}

load_config() {
  if [[ -f "${CONFIG_FILE}" ]]; then
    # shellcheck disable=SC1090
    source "${CONFIG_FILE}"
  fi
}

save_config() {
  mkdir -p "${CONFIG_DIR}"
  {
    printf 'KUBECTL_CONTEXT=%q\n' "${KUBECTL_CONTEXT}"
    printf 'CLUSTER_NAME=%q\n' "${CLUSTER_NAME}"
    printf 'NFS_SERVER=%q\n' "${NFS_SERVER}"
    printf 'NFS_EXPORT_PATH=%q\n' "${NFS_EXPORT_PATH}"
    printf 'BACKUP_ROOT=%q\n' "${BACKUP_ROOT}"
    printf 'HELPER_IMAGE=%q\n' "${HELPER_IMAGE}"
    printf 'DEFAULT_SCHEDULE=%q\n' "${DEFAULT_SCHEDULE}"
    printf 'RETENTION_DAYS=%q\n' "${RETENTION_DAYS}"
    printf 'KEEP_FAILED_PODS=%q\n' "${KEEP_FAILED_PODS}"
    printf 'ARCHIVE_EXTENSION=%q\n' "${ARCHIVE_EXTENSION}"
    printf 'LOCAL_NFS_PREFLIGHT=%q\n' "${LOCAL_NFS_PREFLIGHT}"
    printf 'SCALE_CONSUMERS_FOR_BACKUP=%q\n' "${SCALE_CONSUMERS_FOR_BACKUP}"
  } > "${CONFIG_FILE}"
}

make_temp_file() {
  local prefix="${1:-tmp}"
  RUNTIME_COUNTER=$((RUNTIME_COUNTER + 1))
  mktemp "${TMP_BASE}/${prefix}-${RUNTIME_COUNTER}-XXXXXX"
}

show_message() {
  local title="$1"
  local message="$2"
  local rendered
  printf -v rendered '%b' "${message}"
  if ! command -v whiptail >/dev/null 2>&1 || [[ ! -t 1 ]]; then
    printf '%s: %s\n' "${title}" "${rendered}" >&2
    return 0
  fi
  whiptail --title "${title}" --msgbox "${rendered}" 20 78
}

show_error() {
  show_message "Error" "$1"
}

show_info() {
  show_message "Info" "$1"
}

show_textbox() {
  local title="$1"
  local file="$2"
  whiptail --title "${title}" --scrolltext --textbox "${file}" 30 120
}

start_live_log_view() {
  local title="$1"
  local file="$2"

  LIVE_TAIL_PID=""
  whiptail --title "${title}" --tailboxbg "${file}" 30 120 < /dev/tty > /dev/tty 2> /dev/tty &
  LIVE_TAIL_PID=$!
  sleep 0.2
}

stop_live_log_view() {
  if [[ -n "${LIVE_TAIL_PID}" ]]; then
    kill "${LIVE_TAIL_PID}" >/dev/null 2>&1 || true
    wait "${LIVE_TAIL_PID}" 2>/dev/null || true
    LIVE_TAIL_PID=""
  fi
}

start_progress_bar() {
  local title="$1"

  stop_live_log_view
  stop_progress_bar
  PROGRESS_FIFO="$(make_temp_file progress-fifo)"
  rm -f "${PROGRESS_FIFO}"
  mkfifo "${PROGRESS_FIFO}"
  whiptail --title "${title}" --gauge "Preparing..." 12 78 0 < "${PROGRESS_FIFO}" > /dev/tty 2> /dev/tty &
  PROGRESS_PID=$!
  exec {PROGRESS_FD}>"${PROGRESS_FIFO}"
}

stop_progress_bar() {
  if [[ -n "${PROGRESS_FD}" ]]; then
    exec {PROGRESS_FD}>&- || true
    PROGRESS_FD=""
  fi

  if [[ -n "${PROGRESS_PID}" ]]; then
    wait "${PROGRESS_PID}" 2>/dev/null || true
    PROGRESS_PID=""
  fi

  if [[ -n "${PROGRESS_FIFO}" ]]; then
    rm -f "${PROGRESS_FIFO}"
    PROGRESS_FIFO=""
  fi

  PROGRESS_ITEM_INDEX=0
  PROGRESS_ITEM_TOTAL=0
}

progress_update() {
  local percent="$1"
  local message="$2"

  [[ -z "${PROGRESS_FD}" ]] && return 0
  (( percent < 0 )) && percent=0
  (( percent > 100 )) && percent=100

  {
    printf 'XXX\n'
    printf '%s\n' "${percent}"
    printf '%s\n' "${message}"
    printf 'XXX\n'
  } >&"${PROGRESS_FD}" 2>/dev/null || true
}

progress_item_update() {
  local item_index="$1"
  local item_total="$2"
  local item_percent="$3"
  local message="$4"
  local overall

  if (( item_total < 1 )); then
    progress_update "${item_percent}" "${message}"
    return 0
  fi

  overall=$(( ((item_index - 1) * 100 + item_percent) / item_total ))
  if (( overall > 99 && item_index < item_total )); then
    overall=99
  fi

  progress_update "${overall}" "${message}"
}

append_log() {
  local log_file="$1"
  shift
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" >> "${log_file}"
}

append_file_block() {
  local log_file="$1"
  local header="$2"
  local source_file="$3"

  append_log "${log_file}" "${header}"
  if [[ -s "${source_file}" ]]; then
    while IFS= read -r line; do
      printf '    %s\n' "${line}" >> "${log_file}"
    done < "${source_file}"
  else
    printf '    <no output>\n' >> "${log_file}"
  fi
}

append_text_block() {
  local log_file="$1"
  local header="$2"
  local text="$3"

  append_log "${log_file}" "${header}"
  if [[ -n "${text}" ]]; then
    while IFS= read -r line; do
      printf '    %s\n' "${line}" >> "${log_file}"
    done <<< "${text}"
  else
    printf '    <no output>\n' >> "${log_file}"
  fi
}

format_command() {
  printf '%q ' "$@"
}

run_privileged() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
    return $?
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo "$@"
    return $?
  fi

  printf 'This action requires root privileges, but sudo is not available.\n' >&2
  return 1
}

run_logged_command() {
  local log_file="$1"
  local description="$2"
  shift 2
  local command_output_file

  command_output_file="$(make_temp_file cmd-output)"
  append_log "${log_file}" "${description}"
  append_log "${log_file}" "Command: $(format_command "$@")"

  if "$@" > "${command_output_file}" 2>&1; then
    append_file_block "${log_file}" "Command output:" "${command_output_file}"
    return 0
  fi

  append_file_block "${log_file}" "Command output:" "${command_output_file}"
  return 1
}

detect_nfs_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then
    printf '%s' "apt"
    return 0
  fi
  if command -v dnf >/dev/null 2>&1; then
    printf '%s' "dnf"
    return 0
  fi
  if command -v yum >/dev/null 2>&1; then
    printf '%s' "yum"
    return 0
  fi
  if command -v zypper >/dev/null 2>&1; then
    printf '%s' "zypper"
    return 0
  fi

  return 1
}

is_mountpoint_path() {
  local target="$1"

  if command -v mountpoint >/dev/null 2>&1; then
    mountpoint -q "${target}"
    return $?
  fi

  grep -qs "[[:space:]]${target}[[:space:]]" /proc/mounts
}

current_mount_source() {
  local target="$1"

  if command -v findmnt >/dev/null 2>&1; then
    findmnt -n -o SOURCE --target "${target}" 2>/dev/null || true
    return 0
  fi

  awk -v target="${target}" '$2 == target { print $1; exit }' /proc/mounts 2>/dev/null || true
}

install_nfs_client_if_needed() {
  local log_file="$1"
  local package_manager

  if command -v mount.nfs >/dev/null 2>&1 || command -v mount.nfs4 >/dev/null 2>&1; then
    append_log "${log_file}" "NFS client utilities already installed."
    return 0
  fi

  if ! package_manager="$(detect_nfs_package_manager)"; then
    append_log "${log_file}" "Could not detect a supported package manager for automatic NFS client installation."
    return 1
  fi

  append_log "${log_file}" "NFS client utilities not found. Attempting installation with ${package_manager}."

  case "${package_manager}" in
    apt)
      run_logged_command "${log_file}" "Refreshing apt metadata." run_privileged apt-get update || return 1
      run_logged_command "${log_file}" "Installing nfs-common." run_privileged apt-get install -y nfs-common || return 1
      ;;
    dnf)
      run_logged_command "${log_file}" "Installing nfs-utils with dnf." run_privileged dnf install -y nfs-utils || return 1
      ;;
    yum)
      run_logged_command "${log_file}" "Installing nfs-utils with yum." run_privileged yum install -y nfs-utils || return 1
      ;;
    zypper)
      run_logged_command "${log_file}" "Installing nfs-client with zypper." run_privileged zypper --non-interactive install nfs-client || return 1
      ;;
  esac

  if command -v mount.nfs >/dev/null 2>&1 || command -v mount.nfs4 >/dev/null 2>&1; then
    append_log "${log_file}" "NFS client utilities installed successfully."
    return 0
  fi

  append_log "${log_file}" "Package installation finished but mount.nfs is still unavailable."
  return 1
}

ensure_local_nfs_mount() {
  local log_file="$1"
  local expected_source="${NFS_SERVER}:${NFS_EXPORT_PATH}"
  local existing_source=""

  if [[ "${LOCAL_NFS_PREFLIGHT}" == "skip" ]]; then
    append_log "${log_file}" "Skipping local NFS mount preflight by configuration."
    append_log "${log_file}" "Backup Pods will still mount ${expected_source} inside the cluster."
    return 0
  fi

  append_log "${log_file}" "Preparing local NFS mount on the admin machine."
  append_log "${log_file}" "Expected local mount: ${expected_source} -> ${LOCAL_NFS_MOUNT_DIR}"

  install_nfs_client_if_needed "${log_file}" || return 1
  run_logged_command "${log_file}" "Ensuring local mount directory exists." run_privileged mkdir -p "${LOCAL_NFS_MOUNT_DIR}" || return 1

  if is_mountpoint_path "${LOCAL_NFS_MOUNT_DIR}"; then
    existing_source="$(current_mount_source "${LOCAL_NFS_MOUNT_DIR}")"
    if [[ "${existing_source}" == "${expected_source}" ]]; then
      append_log "${log_file}" "NFS share is already mounted locally at ${LOCAL_NFS_MOUNT_DIR}."
      return 0
    fi

    append_log "${log_file}" "Mount point ${LOCAL_NFS_MOUNT_DIR} is already in use by ${existing_source:-an unknown source}."
    return 1
  fi

  run_logged_command "${log_file}" "Mounting NFS share locally." run_privileged mount -t nfs "${expected_source}" "${LOCAL_NFS_MOUNT_DIR}" || return 1
  append_log "${log_file}" "Local NFS mount is ready at ${LOCAL_NFS_MOUNT_DIR}."
  return 0
}

show_operation_log() {
  local title="$1"
  local file="$2"
  stop_live_log_view
  show_textbox "${title}" "${file}"
}

prompt_input() {
  local title="$1"
  local prompt="$2"
  local default_value="${3:-}"
  local result

  if ! result=$(whiptail --title "${title}" --inputbox "${prompt}" 12 78 "${default_value}" 3>&1 1>&2 2>&3); then
    return 1
  fi

  printf '%s\n' "${result}"
}

prompt_menu() {
  local title="$1"
  local prompt="$2"
  shift 2
  local result

  if ! result=$(whiptail --title "${title}" --menu "${prompt}" 20 90 10 "$@" 3>&1 1>&2 2>&3); then
    return 1
  fi

  printf '%s\n' "${result}"
}

effective_context_display() {
  if [[ -n "${KUBECTL_CONTEXT}" ]]; then
    printf '%s' "${KUBECTL_CONTEXT}"
    return 0
  fi

  kubectl config current-context 2>/dev/null || printf '%s' "<current context unavailable>"
}

kubectl_cmd() {
  local args=()
  if [[ -n "${KUBECTL_CONTEXT}" ]]; then
    args+=(--context "${KUBECTL_CONTEXT}")
  fi
  kubectl "${args[@]}" "$@"
}

require_dependencies() {
  local mode="${1:-interactive}"
  local missing=()
  local binary

  for binary in kubectl jq awk sed tr mktemp mkfifo date id grep mount mkdir; do
    if ! command -v "${binary}" >/dev/null 2>&1; then
      missing+=("${binary}")
    fi
  done
  if [[ "${mode}" == "interactive" ]] && ! command -v whiptail >/dev/null 2>&1; then
    missing+=("whiptail")
  fi

  if (( ${#missing[@]} > 0 )); then
    show_error "Missing required binaries: ${missing[*]}"
    exit 1
  fi
}

require_cluster_access() {
  local probe
  probe="$(make_temp_file cluster-probe)"

  if ! kubectl_cmd get pvc -A -o json > "${probe}" 2>&1; then
    show_error "Kubernetes API access failed with the configured context.\n\n$(<"${probe}")"
    return 1
  fi

  return 0
}

require_complete_config() {
  local missing=()

  [[ -z "${CLUSTER_NAME}" ]] && missing+=("cluster name")
  [[ -z "${NFS_SERVER}" ]] && missing+=("NFS server")
  [[ -z "${NFS_EXPORT_PATH}" ]] && missing+=("NFS export path")
  [[ -z "${BACKUP_ROOT}" ]] && missing+=("backup root")
  [[ -z "${HELPER_IMAGE}" ]] && missing+=("helper image")
  [[ -z "${DEFAULT_SCHEDULE}" ]] && missing+=("default schedule")
  [[ -z "${RETENTION_DAYS}" ]] && missing+=("retention days")
  [[ -z "${ARCHIVE_EXTENSION}" ]] && missing+=("archive extension")

  if (( ${#missing[@]} > 0 )); then
    show_error "Configuration is incomplete. Missing: ${missing[*]}\n\nUse Configure Settings first."
    return 1
  fi

  if [[ ! "${RETENTION_DAYS}" =~ ^[0-9]+$ ]]; then
    show_error "Retention days must be a non-negative integer."
    return 1
  fi

  return 0
}

sanitize_name_fragment() {
  local input="$1"
  local sanitized

  sanitized="$(printf '%s' "${input}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"

  if [[ -z "${sanitized}" ]]; then
    sanitized="item"
  fi

  printf '%s' "${sanitized}"
}

build_k8s_name() {
  local prefix="$1"
  local base="$2"
  local suffix="${3:-}"
  local safe_base
  local reserve
  local max_base

  safe_base="$(sanitize_name_fragment "${base}")"

  reserve=$(( ${#prefix} + 1 ))
  if [[ -n "${suffix}" ]]; then
    reserve=$(( reserve + ${#suffix} + 1 ))
  fi

  max_base=$(( 63 - reserve ))
  if (( max_base < 1 )); then
    max_base=1
  fi

  safe_base="${safe_base:0:${max_base}}"
  safe_base="$(printf '%s' "${safe_base}" | sed -E 's/-+$//')"
  [[ -z "${safe_base}" ]] && safe_base="x"

  if [[ -n "${suffix}" ]]; then
    printf '%s-%s-%s' "${prefix}" "${safe_base}" "${suffix}"
  else
    printf '%s-%s' "${prefix}" "${safe_base}"
  fi
}

discover_pvcs() {
  local output_file="$1"
  local json_file

  json_file="$(make_temp_file pvc-json)"
  if ! kubectl_cmd get pvc -A -o json > "${json_file}" 2>&1; then
    show_error "Failed to discover PVCs.\n\n$(<"${json_file}")"
    return 1
  fi

  jq -r '
    .items
    | sort_by(.metadata.namespace, .metadata.name)
    | .[]
    | [
        .metadata.namespace,
        .metadata.name,
        (.status.phase // "Unknown"),
        (.spec.storageClassName // "-"),
        ((.status.accessModes // .spec.accessModes // []) | join(",")),
        (.spec.resources.requests.storage // "-"),
        (.spec.volumeName // "-")
      ]
    | @tsv
  ' "${json_file}" > "${output_file}"
}

show_detected_pvcs() {
  local inventory_file
  local output_file

  if ! require_cluster_access; then
    return 1
  fi

  inventory_file="$(make_temp_file pvc-inventory)"
  if ! discover_pvcs "${inventory_file}"; then
    return 1
  fi

  if [[ ! -s "${inventory_file}" ]]; then
    show_info "No PVCs were detected in the cluster."
    return 0
  fi

  output_file="$(make_temp_file pvc-list)"
  awk -F '\t' '
    BEGIN {
      printf "%-24s %-32s %-10s %-18s %-18s %-10s %-28s\n", "NAMESPACE", "PVC", "PHASE", "STORAGECLASS", "ACCESS", "SIZE", "PV"
      printf "%-24s %-32s %-10s %-18s %-18s %-10s %-28s\n", "--------", "---", "-----", "------------", "------", "----", "--"
    }
    {
      printf "%-24s %-32s %-10s %-18s %-18s %-10s %-28s\n", $1, $2, $3, $4, $5, $6, $7
    }
  ' "${inventory_file}" > "${output_file}"

  show_textbox "Detected PVCs" "${output_file}"
}

select_pvcs_from_inventory() {
  local inventory_file="$1"
  local title="$2"
  local prompt="$3"
  local args=()
  local namespace
  local pvc
  local phase
  local storage_class
  local access_modes
  local requested_size
  local bound_pv
  local selection

  while IFS=$'\t' read -r namespace pvc phase storage_class access_modes requested_size bound_pv; do
    [[ -z "${namespace}" || -z "${pvc}" ]] && continue
    args+=(
      "${namespace}/${pvc}"
      "phase=${phase} sc=${storage_class} access=${access_modes} size=${requested_size} pv=${bound_pv}"
      "OFF"
    )
  done < "${inventory_file}"

  if (( ${#args[@]} == 0 )); then
    return 1
  fi

  if ! selection=$(whiptail --title "${title}" --checklist --separate-output "${prompt}" 30 120 18 "${args[@]}" 3>&1 1>&2 2>&3); then
    return 1
  fi

  printf '%s\n' "${selection}"
}

select_one_pvc_from_inventory() {
  local inventory_file="$1"
  local title="$2"
  local prompt="$3"
  local args=()
  local namespace
  local pvc
  local phase
  local storage_class
  local access_modes
  local requested_size
  local bound_pv

  while IFS=$'\t' read -r namespace pvc phase storage_class access_modes requested_size bound_pv; do
    [[ -z "${namespace}" || -z "${pvc}" ]] && continue
    args+=(
      "${namespace}/${pvc}"
      "phase=${phase} sc=${storage_class} access=${access_modes} size=${requested_size} pv=${bound_pv}"
    )
  done < "${inventory_file}"

  if (( ${#args[@]} == 0 )); then
    return 1
  fi

  prompt_menu "${title}" "${prompt}" "${args[@]}"
}

select_archive_from_catalog() {
  local catalog_file="$1"
  local namespace="$2"
  local pvc="$3"
  local args=()
  local archive_name
  local size

  while IFS=$'\t' read -r archive_name size; do
    [[ -z "${archive_name}" ]] && continue
    args+=("${archive_name}" "size=${size:-unknown}")
  done < "${catalog_file}"

  if (( ${#args[@]} == 0 )); then
    return 1
  fi

  prompt_menu "Choose Backup" "Select the backup archive to restore into ${namespace}/${pvc}." "${args[@]}"
}

collect_all_pvc_tags() {
  local inventory_file="$1"
  awk -F '\t' '{ print $1 "/" $2 }' "${inventory_file}"
}

get_inventory_line() {
  local inventory_file="$1"
  local tag="$2"
  awk -F '\t' -v wanted="${tag}" '$1 "/" $2 == wanted { print; exit }' "${inventory_file}"
}

access_modes_allow_multi_node() {
  local access_modes="$1"
  [[ "${access_modes}" == *ReadWriteMany* || "${access_modes}" == *ReadOnlyMany* ]]
}

wait_for_pvc_consumers_gone() {
  local namespace="$1"
  local pvc="$2"
  local timeout_seconds="${3:-300}"
  local log_file="${4:-}"
  local waited=0
  local count

  while (( waited < timeout_seconds )); do
    count="$(kubectl_cmd get pods -n "${namespace}" -o json \
      | jq -r --arg pvc "${pvc}" '
        [
          .items[]
          | select((.status.phase // "") != "Succeeded" and (.status.phase // "") != "Failed")
          | select(any(.spec.volumes[]?; .persistentVolumeClaim? and .persistentVolumeClaim.claimName == $pvc))
        ]
        | length
      ')"

    if [[ "${count}" == "0" ]]; then
      [[ -n "${log_file}" ]] && append_log "${log_file}" "No active Pods are using ${namespace}/${pvc}."
      return 0
    fi

    [[ -n "${log_file}" ]] && append_log "${log_file}" "Waiting for ${count} Pod(s) using ${namespace}/${pvc} to terminate."
    sleep 5
    waited=$((waited + 5))
  done

  [[ -n "${log_file}" ]] && append_log "${log_file}" "Timed out waiting for Pods using ${namespace}/${pvc} to terminate."
  return 1
}

collect_pvc_scale_targets() {
  local namespace="$1"
  local pvc="$2"
  local output_file="$3"
  local pod_owners_file
  local kind
  local name
  local rs_owner_kind
  local rs_owner_name
  local target_kind
  local target_name
  local replicas

  : > "${output_file}"
  pod_owners_file="$(make_temp_file pvc-pod-owners)"

  kubectl_cmd get pods -n "${namespace}" -o json \
    | jq -r --arg pvc "${pvc}" '
      .items[]
      | select((.status.phase // "") != "Succeeded" and (.status.phase // "") != "Failed")
      | select(any(.spec.volumes[]?; .persistentVolumeClaim? and .persistentVolumeClaim.claimName == $pvc))
      | .metadata.ownerReferences[0]? as $owner
      | select($owner != null)
      | [$owner.kind, $owner.name]
      | @tsv
    ' > "${pod_owners_file}"

  while IFS=$'\t' read -r kind name; do
    [[ -z "${kind}" || -z "${name}" ]] && continue
    target_kind="${kind}"
    target_name="${name}"

    if [[ "${kind}" == "ReplicaSet" ]]; then
      rs_owner_kind="$(kubectl_cmd get replicaset -n "${namespace}" "${name}" -o jsonpath='{.metadata.ownerReferences[0].kind}' 2>/dev/null || true)"
      rs_owner_name="$(kubectl_cmd get replicaset -n "${namespace}" "${name}" -o jsonpath='{.metadata.ownerReferences[0].name}' 2>/dev/null || true)"
      if [[ "${rs_owner_kind}" == "Deployment" && -n "${rs_owner_name}" ]]; then
        target_kind="Deployment"
        target_name="${rs_owner_name}"
      fi
    fi

    case "${target_kind}" in
      Deployment|StatefulSet|ReplicaSet)
        replicas="$(kubectl_cmd get "${target_kind}" -n "${namespace}" "${target_name}" -o jsonpath='{.spec.replicas}' 2>/dev/null || true)"
        [[ -z "${replicas}" ]] && replicas="1"
        printf '%s\t%s\t%s\t%s\n' "${target_kind}" "${target_name}" "${replicas}" "${namespace}/${pvc}" >> "${output_file}"
        ;;
    esac
  done < "${pod_owners_file}"

  if [[ -s "${output_file}" ]]; then
    sort -u "${output_file}" -o "${output_file}"
  fi
}

scale_down_pvc_consumers() {
  local namespace="$1"
  local pvc="$2"
  local state_file="$3"
  local log_file="$4"
  local kind
  local name
  local replicas
  local source

  : > "${state_file}"

  if [[ "${SCALE_CONSUMERS_FOR_BACKUP}" != "true" ]]; then
    append_log "${log_file}" "Consumer scaling is disabled; leaving workloads as-is for ${namespace}/${pvc}."
    return 0
  fi

  collect_pvc_scale_targets "${namespace}" "${pvc}" "${state_file}"
  if [[ ! -s "${state_file}" ]]; then
    append_log "${log_file}" "No scalable Deployment/StatefulSet/ReplicaSet consumers found for ${namespace}/${pvc}."
    return 0
  fi

  append_file_block "${log_file}" "Scaling these PVC consumers to zero:" "${state_file}"
  while IFS=$'\t' read -r kind name replicas source; do
    [[ -z "${kind}" || -z "${name}" ]] && continue
    append_log "${log_file}" "Scaling ${namespace}/${kind}/${name} from ${replicas} to 0 before operating on ${source}."
    kubectl_cmd scale "${kind}" -n "${namespace}" "${name}" --replicas=0 >/dev/null
  done < "${state_file}"

  wait_for_pvc_consumers_gone "${namespace}" "${pvc}" 300 "${log_file}"
}

restore_scaled_consumers() {
  local state_file="$1"
  local log_file="$2"
  local namespace="$3"
  local kind
  local name
  local replicas
  local source

  if [[ ! -s "${state_file}" ]]; then
    return 0
  fi

  while IFS=$'\t' read -r kind name replicas source; do
    [[ -z "${kind}" || -z "${name}" ]] && continue
    append_log "${log_file}" "Restoring ${namespace}/${kind}/${name} to ${replicas} replicas after operating on ${source}."
    kubectl_cmd scale "${kind}" -n "${namespace}" "${name}" --replicas="${replicas}" >/dev/null || true
  done < "${state_file}"
}

inspect_pvc_placement() {
  local namespace="$1"
  local pvc="$2"
  local access_modes="$3"
  local pods_file
  local inspect_error_file
  local unique_nodes=()
  local pod_names=()
  local node_name
  local pod_name
  local seen_nodes=""

  PLACEMENT_MODE="unpinned"
  PINNED_NODE=""
  CONSUMER_SUMMARY="No currently scheduled Pods reference this PVC."

  pods_file="$(make_temp_file pod-usage)"
  inspect_error_file="$(make_temp_file pod-usage-error)"
  if ! {
    kubectl_cmd get pods -n "${namespace}" -o json \
      | jq -r --arg pvc "${pvc}" '
        .items[]
        | select((.status.phase // "") != "Succeeded" and (.status.phase // "") != "Failed")
        | select(any(.spec.volumes[]?; .persistentVolumeClaim? and .persistentVolumeClaim.claimName == $pvc))
        | [.metadata.name, (.spec.nodeName // "")]
        | @tsv
      '
  } > "${pods_file}" 2> "${inspect_error_file}"; then
    PLACEMENT_MODE="unsafe-multi-node"
    CONSUMER_SUMMARY="Could not inspect consuming Pods safely: $(<"${inspect_error_file}")"
    return 0
  fi

  while IFS=$'\t' read -r pod_name node_name; do
    [[ -z "${pod_name}" ]] && continue
    pod_names+=("${pod_name}")
    if [[ -n "${node_name}" && ",${seen_nodes}," != *",${node_name},"* ]]; then
      unique_nodes+=("${node_name}")
      seen_nodes="${seen_nodes},${node_name}"
    fi
  done < "${pods_file}"

  if (( ${#pod_names[@]} > 0 )); then
    CONSUMER_SUMMARY="Pods: ${pod_names[*]}"
  fi

  if (( ${#unique_nodes[@]} == 1 )); then
    PLACEMENT_MODE="pinned"
    PINNED_NODE="${unique_nodes[0]}"
    CONSUMER_SUMMARY="${CONSUMER_SUMMARY} | node=${PINNED_NODE}"
    return 0
  fi

  if (( ${#unique_nodes[@]} > 1 )); then
    if access_modes_allow_multi_node "${access_modes}"; then
      PLACEMENT_MODE="shared-ok"
      CONSUMER_SUMMARY="${CONSUMER_SUMMARY} | nodes=${unique_nodes[*]}"
      return 0
    fi

    PLACEMENT_MODE="unsafe-multi-node"
    CONSUMER_SUMMARY="${CONSUMER_SUMMARY} | nodes=${unique_nodes[*]}"
    return 0
  fi

  return 0
}

render_container_command_block() {
  local indent="$1"
  while IFS= read -r line; do
    printf '%s%s\n' "${indent}" "${line}"
  done <<'EOF'
- |
  timestamp="$(date +%F_%H-%M-%S)"
  target_dir="/backup/${BACKUP_ROOT}/${CLUSTER_NAME}/${PVC_NAMESPACE}/${PVC_NAME}"
  archive="${target_dir}/${timestamp}.${ARCHIVE_EXTENSION}"
  mkdir -p "${target_dir}"
  tar -C /source -czf "${archive}" .
  echo "Backup written to ${archive}"
  if [ "${ENABLE_RETENTION}" = "true" ]; then
    find "${target_dir}" -maxdepth 1 -type f -name "*.${ARCHIVE_EXTENSION}" -mtime "+${RETENTION_DAYS}" -delete
  fi
EOF
}

render_restore_command_block() {
  local indent="$1"
  while IFS= read -r line; do
    printf '%s%s\n' "${indent}" "${line}"
  done <<'EOF'
- |
  archive="/backup/${BACKUP_ROOT}/${CLUSTER_NAME}/${PVC_NAMESPACE}/${PVC_NAME}/${ARCHIVE_NAME}"
  if [ ! -f "${archive}" ]; then
    echo "Archive not found: ${archive}" >&2
    exit 1
  fi
  mkdir -p /target
  find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  tar -C /target -xzf "${archive}"
  echo "Restore completed from ${archive}"
EOF
}

render_archive_catalog_command_block() {
  local indent="$1"
  while IFS= read -r line; do
    printf '%s%s\n' "${indent}" "${line}"
  done <<'EOF'
- |
  target_dir="/backup/${BACKUP_ROOT}/${CLUSTER_NAME}/${PVC_NAMESPACE}/${PVC_NAME}"
  if [ ! -d "${target_dir}" ]; then
    exit 0
  fi
  for archive in "${target_dir}"/*.${ARCHIVE_EXTENSION}; do
    [ -f "${archive}" ] || continue
    size="$(du -h "${archive}" | awk '{print $1}')"
    printf '%s\t%s\n' "$(basename "${archive}")" "${size}"
  done | sort -r
EOF
}

write_helper_pod_manifest() {
  local manifest_file="$1"
  local namespace="$2"
  local pvc="$3"
  local pod_name="$4"
  local pinned_node="${5:-}"

  {
    cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${pod_name}
  namespace: ${namespace}
  labels:
    ${APP_LABEL_NAME}: ${APP_LABEL_VALUE}
    ${APP_LABEL_COMPONENT}: on-demand-backup
    backup-pvc: ${pvc}
spec:
  restartPolicy: Never
EOF
    if [[ -n "${pinned_node}" ]]; then
      printf '  nodeName: %s\n' "${pinned_node}"
    fi
    cat <<EOF
  containers:
    - name: backup
      image: "$(yaml_escape "${HELPER_IMAGE}")"
      imagePullPolicy: IfNotPresent
      command:
        - /bin/sh
        - -ceu
      args:
EOF
    render_container_command_block "        "
    cat <<EOF
      env:
        - name: BACKUP_ROOT
          value: "$(yaml_escape "${BACKUP_ROOT}")"
        - name: CLUSTER_NAME
          value: "$(yaml_escape "${CLUSTER_NAME}")"
        - name: PVC_NAMESPACE
          value: "$(yaml_escape "${namespace}")"
        - name: PVC_NAME
          value: "$(yaml_escape "${pvc}")"
        - name: ARCHIVE_EXTENSION
          value: "$(yaml_escape "${ARCHIVE_EXTENSION}")"
        - name: ENABLE_RETENTION
          value: "false"
        - name: RETENTION_DAYS
          value: "$(yaml_escape "${RETENTION_DAYS}")"
      volumeMounts:
        - name: source
          mountPath: /source
          readOnly: true
        - name: backup
          mountPath: /backup
  volumes:
    - name: source
      persistentVolumeClaim:
        claimName: ${pvc}
        readOnly: true
    - name: backup
      nfs:
        server: "$(yaml_escape "${NFS_SERVER}")"
        path: "$(yaml_escape "${NFS_EXPORT_PATH}")"
EOF
  } > "${manifest_file}"
}

write_archive_catalog_pod_manifest() {
  local manifest_file="$1"
  local namespace="$2"
  local pvc="$3"
  local pod_name="$4"

  {
    cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${pod_name}
  namespace: ${namespace}
  labels:
    ${APP_LABEL_NAME}: ${APP_LABEL_VALUE}
    ${APP_LABEL_COMPONENT}: restore-catalog
    backup-pvc: ${pvc}
spec:
  restartPolicy: Never
  containers:
    - name: catalog
      image: "$(yaml_escape "${HELPER_IMAGE}")"
      imagePullPolicy: IfNotPresent
      command:
        - /bin/sh
        - -ceu
      args:
EOF
    render_archive_catalog_command_block "        "
    cat <<EOF
      env:
        - name: BACKUP_ROOT
          value: "$(yaml_escape "${BACKUP_ROOT}")"
        - name: CLUSTER_NAME
          value: "$(yaml_escape "${CLUSTER_NAME}")"
        - name: PVC_NAMESPACE
          value: "$(yaml_escape "${namespace}")"
        - name: PVC_NAME
          value: "$(yaml_escape "${pvc}")"
        - name: ARCHIVE_EXTENSION
          value: "$(yaml_escape "${ARCHIVE_EXTENSION}")"
      volumeMounts:
        - name: backup
          mountPath: /backup
          readOnly: true
  volumes:
    - name: backup
      nfs:
        server: "$(yaml_escape "${NFS_SERVER}")"
        path: "$(yaml_escape "${NFS_EXPORT_PATH}")"
EOF
  } > "${manifest_file}"
}

write_restore_pod_manifest() {
  local manifest_file="$1"
  local namespace="$2"
  local pvc="$3"
  local pod_name="$4"
  local archive_name="$5"

  {
    cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${pod_name}
  namespace: ${namespace}
  labels:
    ${APP_LABEL_NAME}: ${APP_LABEL_VALUE}
    ${APP_LABEL_COMPONENT}: restore
    backup-pvc: ${pvc}
spec:
  restartPolicy: Never
  containers:
    - name: restore
      image: "$(yaml_escape "${HELPER_IMAGE}")"
      imagePullPolicy: IfNotPresent
      command:
        - /bin/sh
        - -ceu
      args:
EOF
    render_restore_command_block "        "
    cat <<EOF
      env:
        - name: BACKUP_ROOT
          value: "$(yaml_escape "${BACKUP_ROOT}")"
        - name: CLUSTER_NAME
          value: "$(yaml_escape "${CLUSTER_NAME}")"
        - name: PVC_NAMESPACE
          value: "$(yaml_escape "${namespace}")"
        - name: PVC_NAME
          value: "$(yaml_escape "${pvc}")"
        - name: ARCHIVE_NAME
          value: "$(yaml_escape "${archive_name}")"
      volumeMounts:
        - name: target
          mountPath: /target
        - name: backup
          mountPath: /backup
          readOnly: true
  volumes:
    - name: target
      persistentVolumeClaim:
        claimName: ${pvc}
    - name: backup
      nfs:
        server: "$(yaml_escape "${NFS_SERVER}")"
        path: "$(yaml_escape "${NFS_EXPORT_PATH}")"
EOF
  } > "${manifest_file}"
}

write_cronjob_manifest() {
  local manifest_file="$1"
  local namespace="$2"
  local pvc="$3"
  local cronjob_name="$4"
  local schedule="$5"
  local pinned_node="${6:-}"
  local retention_enabled="true"

  if [[ "${RETENTION_DAYS}" == "0" ]]; then
    retention_enabled="false"
  fi

  {
    cat <<EOF
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${cronjob_name}
  namespace: ${namespace}
  labels:
    ${APP_LABEL_NAME}: ${APP_LABEL_VALUE}
    ${APP_LABEL_COMPONENT}: schedule
    backup-pvc: ${pvc}
spec:
  schedule: "$(yaml_escape "${schedule}")"
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
      template:
        metadata:
          labels:
            ${APP_LABEL_NAME}: ${APP_LABEL_VALUE}
            ${APP_LABEL_COMPONENT}: schedule
            backup-pvc: ${pvc}
        spec:
          restartPolicy: Never
EOF
    if [[ -n "${pinned_node}" ]]; then
      printf '          nodeName: %s\n' "${pinned_node}"
    fi
    cat <<EOF
          containers:
            - name: backup
              image: "$(yaml_escape "${HELPER_IMAGE}")"
              imagePullPolicy: IfNotPresent
              command:
                - /bin/sh
                - -ceu
              args:
EOF
    render_container_command_block "                "
    cat <<EOF
              env:
                - name: BACKUP_ROOT
                  value: "$(yaml_escape "${BACKUP_ROOT}")"
                - name: CLUSTER_NAME
                  value: "$(yaml_escape "${CLUSTER_NAME}")"
                - name: PVC_NAMESPACE
                  value: "$(yaml_escape "${namespace}")"
                - name: PVC_NAME
                  value: "$(yaml_escape "${pvc}")"
                - name: ARCHIVE_EXTENSION
                  value: "$(yaml_escape "${ARCHIVE_EXTENSION}")"
                - name: ENABLE_RETENTION
                  value: "${retention_enabled}"
                - name: RETENTION_DAYS
                  value: "$(yaml_escape "${RETENTION_DAYS}")"
              volumeMounts:
                - name: source
                  mountPath: /source
                  readOnly: true
                - name: backup
                  mountPath: /backup
          volumes:
            - name: source
              persistentVolumeClaim:
                claimName: ${pvc}
                readOnly: true
            - name: backup
              nfs:
                server: "$(yaml_escape "${NFS_SERVER}")"
                path: "$(yaml_escape "${NFS_EXPORT_PATH}")"
EOF
  } > "${manifest_file}"
}

wait_for_pod_completion() {
  local namespace="$1"
  local pod_name="$2"
  local timeout_seconds="${3:-1800}"
  local log_file="${4:-}"
  local waited=0
  local phase=""
  local last_phase=""

  while (( waited < timeout_seconds )); do
    if ! phase="$(kubectl_cmd get pod -n "${namespace}" "${pod_name}" -o jsonpath='{.status.phase}' 2>/dev/null)"; then
      if [[ -n "${log_file}" && "${last_phase}" != "NotYetVisible" ]]; then
        append_log "${log_file}" "Waiting for Pod ${namespace}/${pod_name}: object not visible yet."
        last_phase="NotYetVisible"
      fi
      sleep 2
      waited=$((waited + 2))
      continue
    fi

    if [[ -n "${log_file}" && "${phase}" != "${last_phase}" ]]; then
      append_log "${log_file}" "Pod ${namespace}/${pod_name} phase=${phase} after ${waited}s."
      last_phase="${phase}"
    fi

    case "${phase}" in
      Succeeded|Failed)
        printf '%s' "${phase}"
        return 0
        ;;
    esac

    if [[ -n "${log_file}" ]] && (( waited > 0 )) && (( waited % 30 == 0 )); then
      append_log "${log_file}" "Still waiting for Pod ${namespace}/${pod_name}; current phase=${phase}; elapsed=${waited}s."
    fi

    if (( PROGRESS_ITEM_TOTAL > 0 && PROGRESS_ITEM_INDEX > 0 )); then
      local wait_progress=$((75 + (waited * 20 / timeout_seconds)))
      (( wait_progress > 95 )) && wait_progress=95
      progress_item_update "${PROGRESS_ITEM_INDEX}" "${PROGRESS_ITEM_TOTAL}" "${wait_progress}" "Waiting for ${namespace}/${pod_name}: phase=${phase}, elapsed=${waited}s"
    fi

    sleep 5
    waited=$((waited + 5))
  done

  if [[ -n "${log_file}" ]]; then
    append_log "${log_file}" "Timed out waiting for Pod ${namespace}/${pod_name} after ${timeout_seconds}s."
  fi
  printf '%s' "Timeout"
}

collect_pod_diagnostics() {
  local namespace="$1"
  local pod_name="$2"
  local log_file="$3"
  local describe_file
  local logs_text

  describe_file="$(make_temp_file pod-describe)"
  kubectl_cmd describe pod -n "${namespace}" "${pod_name}" > "${describe_file}" 2>&1 || true
  append_file_block "${log_file}" "kubectl describe pod ${namespace}/${pod_name}:" "${describe_file}"

  logs_text="$(kubectl_cmd logs -n "${namespace}" "${pod_name}" 2>&1 || true)"
  append_text_block "${log_file}" "kubectl logs ${namespace}/${pod_name}:" "${logs_text}"
}

cleanup_helper_pod() {
  local namespace="$1"
  local pod_name="$2"
  kubectl_cmd delete pod -n "${namespace}" "${pod_name}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}

choose_selection_mode() {
  prompt_menu \
    "Selection Mode" \
    "Choose how to select PVCs." \
    all "Operate on all detected PVCs" \
    select "Choose PVCs interactively"
}

configure_settings() {
  local new_context
  local new_cluster_name
  local new_nfs_server
  local new_nfs_export
  local new_backup_root
  local new_helper_image
  local new_default_schedule
  local new_retention_days
  local new_archive_extension
  local suggested_cluster_name

  suggested_cluster_name="${CLUSTER_NAME}"
  if [[ -z "${suggested_cluster_name}" ]]; then
    suggested_cluster_name="$(effective_context_display)"
  fi

  if ! new_context=$(prompt_input "Configure" "Kubectl context to use. Leave blank to use the current context." "${KUBECTL_CONTEXT}"); then
    return 0
  fi

  if ! new_cluster_name=$(prompt_input "Configure" "Friendly cluster name for the backup directory layout." "${suggested_cluster_name}"); then
    return 0
  fi

  if ! new_nfs_server=$(prompt_input "Configure" "NFS server hostname or IP address." "${NFS_SERVER}"); then
    return 0
  fi

  if ! new_nfs_export=$(prompt_input "Configure" "NFS export path mounted by helper Pods." "${NFS_EXPORT_PATH}"); then
    return 0
  fi

  if ! new_backup_root=$(prompt_input "Configure" "Backup root folder under the NFS export." "${BACKUP_ROOT}"); then
    return 0
  fi

  if ! new_helper_image=$(prompt_input "Configure" "Container image for helper Pods and CronJobs." "${HELPER_IMAGE}"); then
    return 0
  fi

  if ! new_default_schedule=$(prompt_input "Configure" "Default cron schedule for recurring backups." "${DEFAULT_SCHEDULE}"); then
    return 0
  fi

  if ! new_retention_days=$(prompt_input "Configure" "Retention days for scheduled backups. Use 0 to disable cleanup." "${RETENTION_DAYS}"); then
    return 0
  fi

  if ! new_archive_extension=$(prompt_input "Configure" "Archive extension. Compression stays tar.gz based." "${ARCHIVE_EXTENSION}"); then
    return 0
  fi

  if ! whiptail --title "Configure" --yesno $'Keep failed helper Pods for troubleshooting?\n\nChoose Yes to retain failed Pods after on-demand backups.' 12 78; then
    KEEP_FAILED_PODS="false"
  else
    KEEP_FAILED_PODS="true"
  fi

  new_context="$(trim "${new_context}")"
  new_cluster_name="$(trim "${new_cluster_name}")"
  new_nfs_server="$(trim "${new_nfs_server}")"
  new_nfs_export="$(trim "${new_nfs_export}")"
  new_backup_root="$(trim "${new_backup_root}")"
  new_helper_image="$(trim "${new_helper_image}")"
  new_default_schedule="$(trim "${new_default_schedule}")"
  new_retention_days="$(trim "${new_retention_days}")"
  new_archive_extension="$(trim "${new_archive_extension}")"

  if [[ -z "${new_cluster_name}" || -z "${new_nfs_server}" || -z "${new_nfs_export}" || -z "${new_backup_root}" || -z "${new_helper_image}" || -z "${new_default_schedule}" || -z "${new_archive_extension}" ]]; then
    show_error "All fields except kubectl context are required."
    return 1
  fi

  if [[ ! "${new_retention_days}" =~ ^[0-9]+$ ]]; then
    show_error "Retention days must be a non-negative integer."
    return 1
  fi

  if [[ ! "${new_archive_extension}" =~ ^[A-Za-z0-9._-]+$ ]]; then
    show_error "Archive extension may only contain letters, numbers, dot, underscore, or hyphen."
    return 1
  fi

  KUBECTL_CONTEXT="${new_context}"
  CLUSTER_NAME="${new_cluster_name}"
  NFS_SERVER="${new_nfs_server}"
  NFS_EXPORT_PATH="${new_nfs_export}"
  BACKUP_ROOT="${new_backup_root}"
  HELPER_IMAGE="${new_helper_image}"
  DEFAULT_SCHEDULE="${new_default_schedule}"
  RETENTION_DAYS="${new_retention_days}"
  ARCHIVE_EXTENSION="${new_archive_extension}"

  save_config
  show_info "Settings saved to ${CONFIG_FILE}"
}

show_settings() {
  local output_file

  output_file="$(make_temp_file settings)"
  {
    printf 'Config file: %s\n' "${CONFIG_FILE}"
    printf 'Kubectl context: %s\n' "$(effective_context_display)"
    printf 'Cluster name: %s\n' "${CLUSTER_NAME:-<unset>}"
    printf 'NFS server: %s\n' "${NFS_SERVER:-<unset>}"
    printf 'NFS export path: %s\n' "${NFS_EXPORT_PATH:-<unset>}"
    printf 'Local NFS mount dir: %s\n' "${LOCAL_NFS_MOUNT_DIR}"
    printf 'Local NFS preflight: %s\n' "${LOCAL_NFS_PREFLIGHT:-mount}"
    printf 'Backup root: %s\n' "${BACKUP_ROOT:-<unset>}"
    printf 'Helper image: %s\n' "${HELPER_IMAGE:-<unset>}"
    printf 'Default cron schedule: %s\n' "${DEFAULT_SCHEDULE:-<unset>}"
    printf 'Retention days: %s\n' "${RETENTION_DAYS:-<unset>}"
    printf 'Keep failed Pods: %s\n' "${KEEP_FAILED_PODS:-<unset>}"
    printf 'Scale consumers for backup: %s\n' "${SCALE_CONSUMERS_FOR_BACKUP:-false}"
    printf 'Archive extension: %s\n' "${ARCHIVE_EXTENSION:-<unset>}"
    printf '\n'
    printf 'Archive layout:\n'
    printf '/backup/%s/%s/<namespace>/<pvc>/YYYY-MM-DD_HH-MM-SS.%s\n' "${BACKUP_ROOT:-<backup-root>}" "${CLUSTER_NAME:-<cluster>}" "${ARCHIVE_EXTENSION:-tgz}"
  } > "${output_file}"

  show_textbox "Current Settings" "${output_file}"
}

run_backup_now() {
  local inventory_file
  local selection_mode
  local selected_tags_file
  local result_file
  local total_selected=0
  local tag
  local line
  local namespace
  local pvc
  local phase
  local storage_class
  local access_modes
  local requested_size
  local bound_pv
  local manifest_file
  local apply_output_file
  local pod_name
  local run_suffix
  local pod_phase
  local pinned_node=""
  local archive_dir
  local pod_logs
  local scale_state_file
  local selected_count=0

  if ! require_complete_config || ! require_cluster_access; then
    return 1
  fi

  result_file="$(make_temp_file backup-results)"
  {
    printf 'Cluster: %s\n' "${CLUSTER_NAME}"
    printf 'Context: %s\n' "$(effective_context_display)"
    printf 'NFS target: %s:%s\n' "${NFS_SERVER}" "${NFS_EXPORT_PATH}"
    printf 'Local mount dir: %s\n' "${LOCAL_NFS_MOUNT_DIR}"
    printf 'Backup root: %s\n' "${BACKUP_ROOT}"
    printf '\n'
  } > "${result_file}"
  inventory_file="$(make_temp_file pvc-inventory)"
  if ! discover_pvcs "${inventory_file}"; then
    append_log "${result_file}" "PVC discovery failed."
    show_textbox "Backup Results" "${result_file}"
    return 1
  fi

  if [[ ! -s "${inventory_file}" ]]; then
    show_info "No PVCs were detected in the cluster."
    return 0
  fi

  if ! selection_mode="$(choose_selection_mode)"; then
    append_log "${result_file}" "Backup selection was cancelled."
    return 0
  fi
  append_log "${result_file}" "Selection mode: ${selection_mode}"

  selected_tags_file="$(make_temp_file backup-selection)"
  case "${selection_mode}" in
    all)
      collect_all_pvc_tags "${inventory_file}" > "${selected_tags_file}"
      ;;
    select)
      if ! select_pvcs_from_inventory "${inventory_file}" "Choose PVCs" "Select one or more PVCs to back up now." > "${selected_tags_file}"; then
        append_log "${result_file}" "PVC selection dialog was cancelled."
        return 0
      fi
      ;;
    *)
      return 0
      ;;
  esac

  if [[ ! -s "${selected_tags_file}" ]]; then
    show_info "No PVCs were selected."
    return 0
  fi

  selected_count="$(wc -l < "${selected_tags_file}" | tr -d '[:space:]')"
  [[ -z "${selected_count}" ]] && selected_count=0

  start_progress_bar "Backup Progress"
  progress_update 1 "Preparing backup run for ${selected_count} PVC(s)."
  append_log "${result_file}" "Starting on-demand PVC backup workflow."
  append_log "${result_file}" "Discovering PVC inventory completed."
  if ! ensure_local_nfs_mount "${result_file}"; then
    progress_update 100 "Local NFS preflight failed."
    append_log "${result_file}" "Stopping because the local NFS preflight failed."
    stop_progress_bar
    show_operation_log "Backup Results" "${result_file}"
    return 1
  fi
  append_file_block "${result_file}" "Selected PVCs:" "${selected_tags_file}"

  while IFS= read -r tag; do
    [[ -z "${tag}" ]] && continue
    total_selected=$((total_selected + 1))
    PROGRESS_ITEM_INDEX="${total_selected}"
    PROGRESS_ITEM_TOTAL="${selected_count}"
    progress_item_update "${total_selected}" "${selected_count}" 3 "Reading inventory for PVC ${total_selected}/${selected_count}: ${tag}"
    line="$(get_inventory_line "${inventory_file}" "${tag}")"
    if [[ -z "${line}" ]]; then
      progress_item_update "${total_selected}" "${selected_count}" 100 "Skipping ${tag}: missing inventory details."
      printf '[SKIP] %s - missing inventory details\n' "${tag}" >> "${result_file}"
      continue
    fi

    IFS=$'\t' read -r namespace pvc phase storage_class access_modes requested_size bound_pv <<< "${line}"
    archive_dir="${LOCAL_NFS_MOUNT_DIR}/${BACKUP_ROOT}/${CLUSTER_NAME}/${namespace}/${pvc}"

    printf '[START] %s/%s\n' "${namespace}" "${pvc}" >> "${result_file}"
    printf '        phase=%s storageClass=%s access=%s size=%s pv=%s\n' "${phase}" "${storage_class}" "${access_modes}" "${requested_size}" "${bound_pv}" >> "${result_file}"
    append_log "${result_file}" "Preparing backup for ${namespace}/${pvc}."
    append_log "${result_file}" "Expected archive directory: ${archive_dir}"

    if [[ "${phase}" != "Bound" ]]; then
      progress_item_update "${total_selected}" "${selected_count}" 100 "Skipping ${namespace}/${pvc}: PVC phase is ${phase}."
      printf '[SKIP] %s/%s - PVC is not Bound (phase=%s)\n\n' "${namespace}" "${pvc}" "${phase}" >> "${result_file}"
      append_log "${result_file}" "Skipping ${namespace}/${pvc} because phase is ${phase}."
      continue
    fi

    progress_item_update "${total_selected}" "${selected_count}" 10 "Inspecting consumers for ${namespace}/${pvc}."
    inspect_pvc_placement "${namespace}" "${pvc}" "${access_modes}"
    append_log "${result_file}" "Placement decision for ${namespace}/${pvc}: ${PLACEMENT_MODE} (${CONSUMER_SUMMARY})"
    if [[ "${PLACEMENT_MODE}" == "unsafe-multi-node" ]]; then
      progress_item_update "${total_selected}" "${selected_count}" 100 "Skipping ${namespace}/${pvc}: unsafe multi-node use."
      printf '[SKIP] %s/%s - unsafe multi-node usage for non-RWX/ROX PVC. %s\n\n' "${namespace}" "${pvc}" "${CONSUMER_SUMMARY}" >> "${result_file}"
      continue
    fi

    pinned_node=""
    if [[ "${PLACEMENT_MODE}" == "pinned" ]]; then
      pinned_node="${PINNED_NODE}"
    fi

    printf '        placement=%s %s\n' "${PLACEMENT_MODE}" "${CONSUMER_SUMMARY}" >> "${result_file}"

    scale_state_file="$(make_temp_file scale-state)"
    progress_item_update "${total_selected}" "${selected_count}" 25 "Scaling consumers down for ${namespace}/${pvc}."
    if ! scale_down_pvc_consumers "${namespace}" "${pvc}" "${scale_state_file}" "${result_file}"; then
      progress_item_update "${total_selected}" "${selected_count}" 100 "Failed to scale consumers for ${namespace}/${pvc}; restoring any changes."
      printf '[FAIL] %s/%s - could not scale PVC consumers down safely\n\n' "${namespace}" "${pvc}" >> "${result_file}"
      restore_scaled_consumers "${scale_state_file}" "${result_file}" "${namespace}"
      continue
    fi

    progress_item_update "${total_selected}" "${selected_count}" 45 "Creating backup helper Pod for ${namespace}/${pvc}."
    run_suffix="$(date +%Y%m%d%H%M%S)"
    pod_name="$(build_k8s_name "backup" "${pvc}" "${run_suffix}")"
    manifest_file="$(make_temp_file pod-manifest)"
    apply_output_file="$(make_temp_file pod-apply)"
    write_helper_pod_manifest "${manifest_file}" "${namespace}" "${pvc}" "${pod_name}" "${pinned_node}"
    append_log "${result_file}" "Generated helper Pod manifest for ${namespace}/${pvc}: ${manifest_file}"
    append_file_block "${result_file}" "Manifest content:" "${manifest_file}"

    if ! kubectl_cmd apply -f "${manifest_file}" > "${apply_output_file}" 2>&1; then
      progress_item_update "${total_selected}" "${selected_count}" 100 "Failed to create helper Pod for ${namespace}/${pvc}; restoring consumers."
      printf '[FAIL] %s/%s - failed to create helper Pod from %s\n' "${namespace}" "${pvc}" "${manifest_file}" >> "${result_file}"
      append_file_block "${result_file}" "kubectl apply output:" "${apply_output_file}"
      restore_scaled_consumers "${scale_state_file}" "${result_file}" "${namespace}"
      continue
    fi
    append_file_block "${result_file}" "kubectl apply output:" "${apply_output_file}"

    append_log "${result_file}" "Waiting for helper Pod ${namespace}/${pod_name} to finish."
    progress_item_update "${total_selected}" "${selected_count}" 70 "Backup Pod is running for ${namespace}/${pvc}."
    pod_phase="$(wait_for_pod_completion "${namespace}" "${pod_name}" 1800 "${result_file}")"
    pod_logs="$(kubectl_cmd logs -n "${namespace}" "${pod_name}" 2>&1 || true)"

    printf '        pod=%s phase=%s\n' "${pod_name}" "${pod_phase}" >> "${result_file}"
    if [[ -n "${pod_logs}" ]]; then
      append_text_block "${result_file}" "kubectl logs ${namespace}/${pod_name}:" "${pod_logs}"
    fi

    case "${pod_phase}" in
      Succeeded)
        progress_item_update "${total_selected}" "${selected_count}" 96 "Backup completed for ${namespace}/${pvc}; cleaning up."
        printf '[OK] %s/%s backup completed\n\n' "${namespace}" "${pvc}" >> "${result_file}"
        append_log "${result_file}" "Backup completed for ${namespace}/${pvc}. Cleaning up helper Pod."
        cleanup_helper_pod "${namespace}" "${pod_name}"
        ;;
      Failed|Timeout)
        progress_item_update "${total_selected}" "${selected_count}" 96 "Backup failed for ${namespace}/${pvc}; collecting diagnostics."
        printf '[FAIL] %s/%s backup ended with phase=%s\n\n' "${namespace}" "${pvc}" "${pod_phase}" >> "${result_file}"
        collect_pod_diagnostics "${namespace}" "${pod_name}" "${result_file}"
        if [[ "${KEEP_FAILED_PODS}" != "true" ]]; then
          append_log "${result_file}" "Removing failed helper Pod ${namespace}/${pod_name}."
          cleanup_helper_pod "${namespace}" "${pod_name}"
        else
          append_log "${result_file}" "Keeping failed helper Pod ${namespace}/${pod_name} for troubleshooting."
        fi
        ;;
      *)
        progress_item_update "${total_selected}" "${selected_count}" 96 "Backup ended unexpectedly for ${namespace}/${pvc}; collecting diagnostics."
        printf '[FAIL] %s/%s backup ended with unexpected phase=%s\n\n' "${namespace}" "${pvc}" "${pod_phase}" >> "${result_file}"
        collect_pod_diagnostics "${namespace}" "${pod_name}" "${result_file}"
        if [[ "${KEEP_FAILED_PODS}" != "true" ]]; then
          append_log "${result_file}" "Removing helper Pod ${namespace}/${pod_name} after unexpected phase."
          cleanup_helper_pod "${namespace}" "${pod_name}"
        else
          append_log "${result_file}" "Keeping helper Pod ${namespace}/${pod_name} after unexpected phase for troubleshooting."
        fi
        ;;
    esac

    progress_item_update "${total_selected}" "${selected_count}" 98 "Restoring consumers for ${namespace}/${pvc}."
    restore_scaled_consumers "${scale_state_file}" "${result_file}" "${namespace}"
    progress_item_update "${total_selected}" "${selected_count}" 100 "Finished ${namespace}/${pvc} (${total_selected}/${selected_count})."
  done < "${selected_tags_file}"

  if (( total_selected == 0 )); then
    stop_progress_bar
    show_info "No PVCs were selected."
    return 0
  fi

  progress_update 100 "Backup workflow finished. Opening results."
  sleep 0.5
  stop_progress_bar
  append_log "${result_file}" "Backup workflow finished."
  show_operation_log "Backup Results" "${result_file}"
}

create_schedules() {
  local inventory_file
  local selected_tags_file
  local selection_mode
  local schedule
  local result_file
  local tag
  local line
  local namespace
  local pvc
  local phase
  local storage_class
  local access_modes
  local requested_size
  local bound_pv
  local manifest_file
  local apply_output_file
  local cronjob_name
  local pinned_node=""

  if ! require_complete_config || ! require_cluster_access; then
    return 1
  fi

  if ! schedule=$(prompt_input "Schedule" "Cron expression for the recurring backups." "${DEFAULT_SCHEDULE}"); then
    return 0
  fi
  schedule="$(trim "${schedule}")"

  if [[ -z "${schedule}" ]]; then
    show_error "Cron schedule cannot be empty."
    return 1
  fi

  DEFAULT_SCHEDULE="${schedule}"
  save_config

  result_file="$(make_temp_file schedule-results)"
  {
    printf 'Cluster: %s\n' "${CLUSTER_NAME}"
    printf 'Context: %s\n' "$(effective_context_display)"
    printf 'Schedule: %s\n' "${schedule}"
    printf 'Retention days: %s\n' "${RETENTION_DAYS}"
    printf 'NFS target: %s:%s\n' "${NFS_SERVER}" "${NFS_EXPORT_PATH}"
    printf 'Local mount dir: %s\n' "${LOCAL_NFS_MOUNT_DIR}"
    printf '\n'
  } > "${result_file}"
  inventory_file="$(make_temp_file pvc-inventory)"
  if ! discover_pvcs "${inventory_file}"; then
    append_log "${result_file}" "PVC discovery failed."
    show_textbox "Schedule Results" "${result_file}"
    return 1
  fi

  if [[ ! -s "${inventory_file}" ]]; then
    show_info "No PVCs were detected in the cluster."
    return 0
  fi

  if ! selection_mode="$(choose_selection_mode)"; then
    append_log "${result_file}" "Schedule selection was cancelled."
    return 0
  fi
  append_log "${result_file}" "Selection mode: ${selection_mode}"

  selected_tags_file="$(make_temp_file schedule-selection)"
  case "${selection_mode}" in
    all)
      collect_all_pvc_tags "${inventory_file}" > "${selected_tags_file}"
      ;;
    select)
      if ! select_pvcs_from_inventory "${inventory_file}" "Choose PVCs" "Select one or more PVCs to schedule." > "${selected_tags_file}"; then
        append_log "${result_file}" "PVC selection dialog was cancelled."
        return 0
      fi
      ;;
    *)
      return 0
      ;;
  esac

  if [[ ! -s "${selected_tags_file}" ]]; then
    show_info "No PVCs were selected."
    return 0
  fi

  start_live_log_view "Schedule Progress" "${result_file}"
  append_log "${result_file}" "Starting recurring backup schedule workflow."
  append_log "${result_file}" "Discovering PVC inventory for schedule creation completed."
  if ! ensure_local_nfs_mount "${result_file}"; then
    append_log "${result_file}" "Stopping because the local NFS preflight failed."
    show_operation_log "Schedule Results" "${result_file}"
    return 1
  fi
  append_file_block "${result_file}" "Selected PVCs:" "${selected_tags_file}"

  while IFS= read -r tag; do
    [[ -z "${tag}" ]] && continue
    line="$(get_inventory_line "${inventory_file}" "${tag}")"
    if [[ -z "${line}" ]]; then
      printf '[SKIP] %s - missing inventory details\n' "${tag}" >> "${result_file}"
      continue
    fi

    IFS=$'\t' read -r namespace pvc phase storage_class access_modes requested_size bound_pv <<< "${line}"

    printf '[START] %s/%s\n' "${namespace}" "${pvc}" >> "${result_file}"
    append_log "${result_file}" "Preparing CronJob for ${namespace}/${pvc}."
    if [[ "${phase}" != "Bound" ]]; then
      printf '[SKIP] %s/%s - PVC is not Bound (phase=%s)\n\n' "${namespace}" "${pvc}" "${phase}" >> "${result_file}"
      append_log "${result_file}" "Skipping ${namespace}/${pvc} because phase is ${phase}."
      continue
    fi

    inspect_pvc_placement "${namespace}" "${pvc}" "${access_modes}"
    append_log "${result_file}" "Placement decision for ${namespace}/${pvc}: ${PLACEMENT_MODE} (${CONSUMER_SUMMARY})"
    if [[ "${PLACEMENT_MODE}" == "unsafe-multi-node" ]]; then
      printf '[SKIP] %s/%s - unsafe multi-node usage for non-RWX/ROX PVC. %s\n\n' "${namespace}" "${pvc}" "${CONSUMER_SUMMARY}" >> "${result_file}"
      continue
    fi

    pinned_node=""
    if [[ "${PLACEMENT_MODE}" == "pinned" ]]; then
      pinned_node="${PINNED_NODE}"
    fi

    cronjob_name="$(build_k8s_name "pvc-backup" "${pvc}")"
    manifest_file="$(make_temp_file cronjob-manifest)"
    apply_output_file="$(make_temp_file cronjob-apply)"
    write_cronjob_manifest "${manifest_file}" "${namespace}" "${pvc}" "${cronjob_name}" "${schedule}" "${pinned_node}"
    append_log "${result_file}" "Generated CronJob manifest for ${namespace}/${pvc}: ${manifest_file}"
    append_file_block "${result_file}" "Manifest content:" "${manifest_file}"

    if kubectl_cmd apply -f "${manifest_file}" > "${apply_output_file}" 2>&1; then
      append_file_block "${result_file}" "kubectl apply output:" "${apply_output_file}"
      printf '[OK] %s/%s scheduled as CronJob %s (placement=%s)\n\n' "${namespace}" "${pvc}" "${cronjob_name}" "${PLACEMENT_MODE}" >> "${result_file}"
    else
      printf '[FAIL] %s/%s - failed to apply CronJob manifest %s\n' "${namespace}" "${pvc}" "${manifest_file}" >> "${result_file}"
      append_file_block "${result_file}" "kubectl apply output:" "${apply_output_file}"
    fi
  done < "${selected_tags_file}"

  append_log "${result_file}" "Schedule workflow finished."
  show_operation_log "Schedule Results" "${result_file}"
}

run_backup_single_pvc() {
  local namespace="$1"
  local pvc="$2"
  local inventory_file
  local result_file
  local line
  local phase
  local storage_class
  local access_modes
  local requested_size
  local bound_pv
  local manifest_file
  local apply_output_file
  local pod_name
  local run_suffix
  local pod_phase
  local pinned_node=""
  local pod_logs
  local scale_state_file

  if ! require_complete_config || ! require_cluster_access; then
    return 1
  fi

  result_file="$(make_temp_file backup-single-results)"
  {
    printf 'Cluster: %s\n' "${CLUSTER_NAME}"
    printf 'Context: %s\n' "$(effective_context_display)"
    printf 'PVC: %s/%s\n' "${namespace}" "${pvc}"
    printf 'NFS target: %s:%s\n' "${NFS_SERVER}" "${NFS_EXPORT_PATH}"
    printf 'Backup root: %s\n\n' "${BACKUP_ROOT}"
  } > "${result_file}"

  inventory_file="$(make_temp_file pvc-inventory)"
  discover_pvcs "${inventory_file}" || return 1
  line="$(get_inventory_line "${inventory_file}" "${namespace}/${pvc}")"
  if [[ -z "${line}" ]]; then
    append_log "${result_file}" "PVC ${namespace}/${pvc} was not found."
    cat "${result_file}"
    return 1
  fi

  IFS=$'\t' read -r namespace pvc phase storage_class access_modes requested_size bound_pv <<< "${line}"
  append_log "${result_file}" "Preparing backup for ${namespace}/${pvc}."
  append_log "${result_file}" "PVC details: phase=${phase} storageClass=${storage_class} access=${access_modes} size=${requested_size} pv=${bound_pv}"

  if [[ "${phase}" != "Bound" ]]; then
    append_log "${result_file}" "PVC is not Bound; stopping."
    cat "${result_file}"
    return 1
  fi

  ensure_local_nfs_mount "${result_file}" || {
    append_log "${result_file}" "Local NFS preflight failed."
    cat "${result_file}"
    return 1
  }

  inspect_pvc_placement "${namespace}" "${pvc}" "${access_modes}"
  append_log "${result_file}" "Placement decision: ${PLACEMENT_MODE} (${CONSUMER_SUMMARY})"
  if [[ "${PLACEMENT_MODE}" == "unsafe-multi-node" ]]; then
    append_log "${result_file}" "Unsafe multi-node use for non-RWX/ROX PVC; stopping."
    cat "${result_file}"
    return 1
  fi

  if [[ "${PLACEMENT_MODE}" == "pinned" ]]; then
    pinned_node="${PINNED_NODE}"
  fi

  scale_state_file="$(make_temp_file scale-state)"
  if ! scale_down_pvc_consumers "${namespace}" "${pvc}" "${scale_state_file}" "${result_file}"; then
    append_log "${result_file}" "Could not scale consumers down safely."
    restore_scaled_consumers "${scale_state_file}" "${result_file}" "${namespace}"
    cat "${result_file}"
    return 1
  fi

  run_suffix="$(date +%Y%m%d%H%M%S)"
  pod_name="$(build_k8s_name "backup" "${pvc}" "${run_suffix}")"
  manifest_file="$(make_temp_file pod-manifest)"
  apply_output_file="$(make_temp_file pod-apply)"
  write_helper_pod_manifest "${manifest_file}" "${namespace}" "${pvc}" "${pod_name}" "${pinned_node}"
  append_log "${result_file}" "Generated helper Pod manifest: ${manifest_file}"

  if ! kubectl_cmd apply -f "${manifest_file}" > "${apply_output_file}" 2>&1; then
    append_file_block "${result_file}" "kubectl apply output:" "${apply_output_file}"
    restore_scaled_consumers "${scale_state_file}" "${result_file}" "${namespace}"
    cat "${result_file}"
    return 1
  fi
  append_file_block "${result_file}" "kubectl apply output:" "${apply_output_file}"

  pod_phase="$(wait_for_pod_completion "${namespace}" "${pod_name}" 1800 "${result_file}")"
  pod_logs="$(kubectl_cmd logs -n "${namespace}" "${pod_name}" 2>&1 || true)"
  append_text_block "${result_file}" "kubectl logs ${namespace}/${pod_name}:" "${pod_logs}"

  case "${pod_phase}" in
    Succeeded)
      append_log "${result_file}" "Backup completed for ${namespace}/${pvc}."
      cleanup_helper_pod "${namespace}" "${pod_name}"
      ;;
    *)
      append_log "${result_file}" "Backup failed with helper Pod phase=${pod_phase}."
      collect_pod_diagnostics "${namespace}" "${pod_name}" "${result_file}"
      if [[ "${KEEP_FAILED_PODS}" != "true" ]]; then
        cleanup_helper_pod "${namespace}" "${pod_name}"
      fi
      ;;
  esac

  restore_scaled_consumers "${scale_state_file}" "${result_file}" "${namespace}"
  append_log "${result_file}" "Result log: ${result_file}"
  cat "${result_file}"
  [[ "${pod_phase}" == "Succeeded" ]]
}

validate_archive_name() {
  local archive_name="$1"

  [[ "${archive_name}" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  [[ "${archive_name}" != *..* ]] || return 1
  [[ "${archive_name}" == *".${ARCHIVE_EXTENSION}" ]] || return 1
}

collect_backup_archives() {
  local namespace="$1"
  local pvc="$2"
  local output_file="$3"
  local log_file="${4:-}"
  local pod_name
  local manifest_file
  local apply_output_file
  local pod_phase
  local pod_logs

  : > "${output_file}"
  pod_name="$(build_k8s_name "restore-catalog" "${pvc}" "$(date +%Y%m%d%H%M%S)")"
  manifest_file="$(make_temp_file restore-catalog-manifest)"
  apply_output_file="$(make_temp_file restore-catalog-apply)"
  write_archive_catalog_pod_manifest "${manifest_file}" "${namespace}" "${pvc}" "${pod_name}"

  [[ -n "${log_file}" ]] && append_log "${log_file}" "Listing backup archives for ${namespace}/${pvc}."
  if ! kubectl_cmd apply -f "${manifest_file}" > "${apply_output_file}" 2>&1; then
    [[ -n "${log_file}" ]] && append_file_block "${log_file}" "kubectl apply output:" "${apply_output_file}"
    return 1
  fi

  pod_phase="$(wait_for_pod_completion "${namespace}" "${pod_name}" 300 "${log_file}")"
  pod_logs="$(kubectl_cmd logs -n "${namespace}" "${pod_name}" 2>&1 || true)"
  cleanup_helper_pod "${namespace}" "${pod_name}"

  if [[ "${pod_phase}" != "Succeeded" ]]; then
    [[ -n "${log_file}" ]] && append_text_block "${log_file}" "Archive catalog Pod logs:" "${pod_logs}"
    return 1
  fi

  printf '%s\n' "${pod_logs}" | awk -F '\t' 'NF >= 1 && $1 != "" { print $1 "\t" ($2 == "" ? "unknown" : $2) }' > "${output_file}"
}

perform_restore_pvc() {
  local namespace="$1"
  local pvc="$2"
  local archive_name="$3"
  local result_file="$4"
  local inventory_file
  local line
  local phase
  local storage_class
  local access_modes
  local requested_size
  local bound_pv
  local scale_state_file
  local manifest_file
  local apply_output_file
  local pod_name
  local pod_phase
  local pod_logs

  if ! validate_archive_name "${archive_name}"; then
    append_log "${result_file}" "Invalid archive name: ${archive_name}"
    return 1
  fi

  inventory_file="$(make_temp_file restore-pvc-inventory)"
  discover_pvcs "${inventory_file}" || return 1
  line="$(get_inventory_line "${inventory_file}" "${namespace}/${pvc}")"
  if [[ -z "${line}" ]]; then
    append_log "${result_file}" "PVC ${namespace}/${pvc} was not found."
    return 1
  fi

  IFS=$'\t' read -r namespace pvc phase storage_class access_modes requested_size bound_pv <<< "${line}"
  append_log "${result_file}" "Preparing restore for ${namespace}/${pvc} from ${archive_name}."
  append_log "${result_file}" "PVC details: phase=${phase} storageClass=${storage_class} access=${access_modes} size=${requested_size} pv=${bound_pv}"

  if [[ "${phase}" != "Bound" ]]; then
    append_log "${result_file}" "PVC is not Bound; stopping."
    return 1
  fi

  ensure_local_nfs_mount "${result_file}" || {
    append_log "${result_file}" "Local NFS preflight failed."
    return 1
  }

  progress_update 10 "Inspecting PVC consumers for ${namespace}/${pvc}."
  inspect_pvc_placement "${namespace}" "${pvc}" "${access_modes}"
  append_log "${result_file}" "Placement decision: ${PLACEMENT_MODE} (${CONSUMER_SUMMARY})"
  if [[ "${PLACEMENT_MODE}" == "unsafe-multi-node" ]]; then
    append_log "${result_file}" "Unsafe multi-node use for non-RWX/ROX PVC; stopping."
    return 1
  fi

  scale_state_file="$(make_temp_file restore-scale-state)"
  progress_update 25 "Scaling consumers down for ${namespace}/${pvc}."
  if ! scale_down_pvc_consumers "${namespace}" "${pvc}" "${scale_state_file}" "${result_file}"; then
    append_log "${result_file}" "Could not scale consumers down safely."
    restore_scaled_consumers "${scale_state_file}" "${result_file}" "${namespace}"
    return 1
  fi

  pod_name="$(build_k8s_name "restore" "${pvc}" "$(date +%Y%m%d%H%M%S)")"
  manifest_file="$(make_temp_file restore-pod-manifest)"
  apply_output_file="$(make_temp_file restore-pod-apply)"
  write_restore_pod_manifest "${manifest_file}" "${namespace}" "${pvc}" "${pod_name}" "${archive_name}"
  append_log "${result_file}" "Generated restore Pod manifest: ${manifest_file}"

  progress_update 45 "Creating restore Pod for ${namespace}/${pvc}."
  if ! kubectl_cmd apply -f "${manifest_file}" > "${apply_output_file}" 2>&1; then
    append_file_block "${result_file}" "kubectl apply output:" "${apply_output_file}"
    restore_scaled_consumers "${scale_state_file}" "${result_file}" "${namespace}"
    return 1
  fi
  append_file_block "${result_file}" "kubectl apply output:" "${apply_output_file}"

  progress_update 65 "Restore Pod is running for ${namespace}/${pvc}."
  PROGRESS_ITEM_INDEX=1
  PROGRESS_ITEM_TOTAL=1
  pod_phase="$(wait_for_pod_completion "${namespace}" "${pod_name}" 1800 "${result_file}")"
  PROGRESS_ITEM_INDEX=0
  PROGRESS_ITEM_TOTAL=0
  pod_logs="$(kubectl_cmd logs -n "${namespace}" "${pod_name}" 2>&1 || true)"
  append_text_block "${result_file}" "kubectl logs ${namespace}/${pod_name}:" "${pod_logs}"

  if [[ "${pod_phase}" == "Succeeded" ]]; then
    progress_update 92 "Restore completed for ${namespace}/${pvc}; cleaning up."
    append_log "${result_file}" "Restore completed for ${namespace}/${pvc} from ${archive_name}."
    cleanup_helper_pod "${namespace}" "${pod_name}"
  else
    progress_update 92 "Restore failed for ${namespace}/${pvc}; collecting diagnostics."
    append_log "${result_file}" "Restore failed with helper Pod phase=${pod_phase}."
    collect_pod_diagnostics "${namespace}" "${pod_name}" "${result_file}"
    if [[ "${KEEP_FAILED_PODS}" != "true" ]]; then
      cleanup_helper_pod "${namespace}" "${pod_name}"
    fi
  fi

  progress_update 97 "Restoring consumers for ${namespace}/${pvc}."
  restore_scaled_consumers "${scale_state_file}" "${result_file}" "${namespace}"
  [[ "${pod_phase}" == "Succeeded" ]]
}

restore_backup() {
  local inventory_file
  local selected_tag
  local namespace
  local pvc
  local catalog_file
  local archive_name
  local result_file

  if ! require_complete_config || ! require_cluster_access; then
    return 1
  fi

  inventory_file="$(make_temp_file restore-pvc-inventory)"
  if ! discover_pvcs "${inventory_file}"; then
    return 1
  fi

  if [[ ! -s "${inventory_file}" ]]; then
    show_info "No PVCs were detected in the cluster."
    return 0
  fi

  if ! selected_tag="$(select_one_pvc_from_inventory "${inventory_file}" "Choose PVC" "Select the PVC to restore into.")"; then
    return 0
  fi

  namespace="${selected_tag%%/*}"
  pvc="${selected_tag#*/}"
  result_file="$(make_temp_file restore-results)"
  {
    printf 'Cluster: %s\n' "${CLUSTER_NAME}"
    printf 'Context: %s\n' "$(effective_context_display)"
    printf 'PVC: %s/%s\n' "${namespace}" "${pvc}"
    printf 'NFS target: %s:%s\n' "${NFS_SERVER}" "${NFS_EXPORT_PATH}"
    printf 'Backup root: %s\n\n' "${BACKUP_ROOT}"
  } > "${result_file}"

  catalog_file="$(make_temp_file restore-catalog)"
  start_progress_bar "Restore Catalog"
  progress_update 20 "Listing backups for ${namespace}/${pvc}."
  if ! collect_backup_archives "${namespace}" "${pvc}" "${catalog_file}" "${result_file}"; then
    progress_update 100 "Could not list backups for ${namespace}/${pvc}."
    sleep 0.5
    stop_progress_bar
    show_operation_log "Restore Results" "${result_file}"
    return 1
  fi
  stop_progress_bar

  if [[ ! -s "${catalog_file}" ]]; then
    show_info "No backup archives were found for ${namespace}/${pvc}."
    return 0
  fi

  if ! archive_name="$(select_archive_from_catalog "${catalog_file}" "${namespace}" "${pvc}")"; then
    return 0
  fi

  if ! whiptail --title "Confirm Restore" --yesno "Restore ${archive_name} into ${namespace}/${pvc}?\n\nThis will delete the current contents of the PVC before extracting the archive. Consumers will be scaled down and restored afterward." 14 86; then
    append_log "${result_file}" "Restore cancelled before applying changes."
    return 0
  fi

  start_progress_bar "Restore Progress"
  progress_update 5 "Starting restore of ${namespace}/${pvc}."
  if perform_restore_pvc "${namespace}" "${pvc}" "${archive_name}" "${result_file}"; then
    progress_update 100 "Restore completed for ${namespace}/${pvc}."
    sleep 0.5
    stop_progress_bar
    show_operation_log "Restore Results" "${result_file}"
    return 0
  fi

  progress_update 100 "Restore failed for ${namespace}/${pvc}."
  sleep 0.5
  stop_progress_bar
  show_operation_log "Restore Results" "${result_file}"
  return 1
}

run_restore_single_pvc() {
  local namespace="$1"
  local pvc="$2"
  local archive_name="$3"
  local result_file

  if ! require_complete_config || ! require_cluster_access; then
    return 1
  fi

  result_file="$(make_temp_file restore-single-results)"
  {
    printf 'Cluster: %s\n' "${CLUSTER_NAME}"
    printf 'Context: %s\n' "$(effective_context_display)"
    printf 'PVC: %s/%s\n' "${namespace}" "${pvc}"
    printf 'Archive: %s\n' "${archive_name}"
    printf 'NFS target: %s:%s\n\n' "${NFS_SERVER}" "${NFS_EXPORT_PATH}"
  } > "${result_file}"

  if perform_restore_pvc "${namespace}" "${pvc}" "${archive_name}" "${result_file}"; then
    append_log "${result_file}" "Result log: ${result_file}"
    cat "${result_file}"
    return 0
  fi

  append_log "${result_file}" "Result log: ${result_file}"
  cat "${result_file}"
  return 1
}

run_list_archives_single_pvc() {
  local namespace="$1"
  local pvc="$2"
  local catalog_file
  local result_file

  if ! require_complete_config || ! require_cluster_access; then
    return 1
  fi

  catalog_file="$(make_temp_file archive-catalog)"
  result_file="$(make_temp_file archive-catalog-results)"
  if collect_backup_archives "${namespace}" "${pvc}" "${catalog_file}" "${result_file}"; then
    cat "${catalog_file}"
    return 0
  fi

  cat "${result_file}" >&2
  return 1
}

list_schedules() {
  local json_file
  local output_file

  if ! require_cluster_access; then
    return 1
  fi

  json_file="$(make_temp_file cronjobs-json)"
  if ! kubectl_cmd get cronjobs -A -l "${APP_LABEL_NAME}=${APP_LABEL_VALUE},${APP_LABEL_COMPONENT}=schedule" -o json > "${json_file}" 2>&1; then
    show_error "Failed to list CronJobs.\n\n$(<"${json_file}")"
    return 1
  fi

  if jq -e '.items | length == 0' "${json_file}" > /dev/null 2>&1; then
    show_info "No schedules created by this tool were found."
    return 0
  fi

  output_file="$(make_temp_file cronjobs-list)"
  jq -r '
    .items
    | sort_by(.metadata.namespace, .metadata.name)
    | (["NAMESPACE","CRONJOB","PVC","SCHEDULE","SUSPENDED","LAST SCHEDULE"] | @tsv),
      (["---------","-------","---","--------","---------","-------------"] | @tsv),
      (.[] | [
        .metadata.namespace,
        .metadata.name,
        (.metadata.labels["backup-pvc"] // "-"),
        (.spec.schedule // "-"),
        ((.spec.suspend // false) | tostring),
        (.status.lastScheduleTime // "-")
      ] | @tsv)
  ' "${json_file}" | awk -F '\t' '
    {
      printf "%-24s %-34s %-24s %-18s %-10s %-24s\n", $1, $2, $3, $4, $5, $6
    }
  ' > "${output_file}"

  show_textbox "Scheduled Backups" "${output_file}"
}

delete_schedules() {
  local json_file
  local rows_file
  local args=()
  local namespace
  local cronjob_name
  local pvc
  local schedule
  local selection
  local result_file
  local tag

  if ! require_cluster_access; then
    return 1
  fi

  json_file="$(make_temp_file cronjobs-json)"
  if ! kubectl_cmd get cronjobs -A -l "${APP_LABEL_NAME}=${APP_LABEL_VALUE},${APP_LABEL_COMPONENT}=schedule" -o json > "${json_file}" 2>&1; then
    show_error "Failed to list CronJobs.\n\n$(<"${json_file}")"
    return 1
  fi

  rows_file="$(make_temp_file cronjobs-rows)"
  jq -r '
    .items
    | sort_by(.metadata.namespace, .metadata.name)
    | .[]
    | [
        .metadata.namespace,
        .metadata.name,
        (.metadata.labels["backup-pvc"] // "-"),
        (.spec.schedule // "-")
      ]
    | @tsv
  ' "${json_file}" > "${rows_file}"

  if [[ ! -s "${rows_file}" ]]; then
    show_info "No schedules created by this tool were found."
    return 0
  fi

  while IFS=$'\t' read -r namespace cronjob_name pvc schedule; do
    args+=(
      "${namespace}/${cronjob_name}"
      "pvc=${pvc} schedule=${schedule}"
      "OFF"
    )
  done < "${rows_file}"

  if ! selection=$(whiptail --title "Delete Schedules" --checklist --separate-output "Select CronJobs to delete." 30 120 18 "${args[@]}" 3>&1 1>&2 2>&3); then
    return 0
  fi

  if [[ -z "${selection}" ]]; then
    show_info "No schedules were selected."
    return 0
  fi

  result_file="$(make_temp_file delete-results)"
  while IFS= read -r tag; do
    [[ -z "${tag}" ]] && continue
    namespace="${tag%%/*}"
    cronjob_name="${tag#*/}"
    if kubectl_cmd delete cronjob -n "${namespace}" "${cronjob_name}" --ignore-not-found > /dev/null 2>&1; then
      printf '[OK] Deleted %s/%s\n' "${namespace}" "${cronjob_name}" >> "${result_file}"
    else
      printf '[FAIL] Could not delete %s/%s\n' "${namespace}" "${cronjob_name}" >> "${result_file}"
    fi
  done <<< "${selection}"

  show_textbox "Delete Results" "${result_file}"
}

show_limitations() {
  local output_file

  output_file="$(make_temp_file limitations)"
  {
    printf 'This tool backs up PVC contents only.\n\n'
    printf 'What it is not:\n'
    printf '%s\n' '- Not a Velero replacement'
    printf '%s\n' '- Not a CSI snapshot tool'
    printf '%s\n' '- Not a disaster recovery system'
    printf '%s\n\n' '- Not an application-consistent database backup solution'
    printf 'Operational limitations:\n'
    printf '%s\n' '- Backups are file-level and usually only crash-consistent'
    printf '%s\n' '- Live databases may need dump hooks or quiescing outside this script'
    printf '%s\n' '- No encryption, checksum catalog, or archive manifest is produced'
    printf '%s\n' '- No RBAC/bootstrap setup is included'
    printf '%s\n' '- Cluster nodes must be able to mount the configured NFS export directly'
    printf '%s\n' '- Scheduled backups create one CronJob per PVC'
    printf '%s\n' '- Restore replaces the selected PVC contents with the selected archive'
    printf '%s\n' '- Restore scales detected Deployment/StatefulSet/ReplicaSet consumers down and restores their replica counts afterward'
  } > "${output_file}"

  show_textbox "Limitations" "${output_file}"
}

main_menu() {
  local choice

  while true; do
    if ! choice=$(prompt_menu \
      "qbackup" \
      "Choose an action." \
      configure "Configure settings" \
      settings "Show current settings" \
      pvc-list "List detected PVCs" \
      backup-now "Run backup immediately" \
      restore-backup "Restore a PVC from backup" \
      create-schedules "Create recurring schedules" \
      list-schedules "List schedules created by this tool" \
      delete-schedules "Delete schedules" \
      limitations "Show limitations and notes" \
      quit "Exit"); then
      break
    fi

    case "${choice}" in
      configure)
        configure_settings
        ;;
      settings)
        show_settings
        ;;
      pvc-list)
        show_detected_pvcs
        ;;
      backup-now)
        run_backup_now
        ;;
      restore-backup)
        restore_backup
        ;;
      create-schedules)
        create_schedules
        ;;
      list-schedules)
        list_schedules
        ;;
      delete-schedules)
        delete_schedules
        ;;
      limitations)
        show_limitations
        ;;
      quit)
        break
        ;;
    esac
  done
}

main() {
  init_runtime
  load_config

  case "${1:-}" in
    --backup-pvc)
      require_dependencies noninteractive
      if [[ "${2:-}" != */* ]]; then
        printf 'Usage: %s --backup-pvc <namespace>/<pvc>\n' "$0" >&2
        exit 2
      fi
      run_backup_single_pvc "${2%%/*}" "${2#*/}"
      exit $?
      ;;
    --restore-pvc)
      require_dependencies noninteractive
      if [[ "${2:-}" != */* || -z "${3:-}" ]]; then
        printf 'Usage: %s --restore-pvc <namespace>/<pvc> <archive-name>\n' "$0" >&2
        exit 2
      fi
      run_restore_single_pvc "${2%%/*}" "${2#*/}" "${3}"
      exit $?
      ;;
    --list-archives)
      require_dependencies noninteractive
      if [[ "${2:-}" != */* ]]; then
        printf 'Usage: %s --list-archives <namespace>/<pvc>\n' "$0" >&2
        exit 2
      fi
      run_list_archives_single_pvc "${2%%/*}" "${2#*/}"
      exit $?
      ;;
  esac

  require_dependencies interactive
  main_menu
}

main "$@"
