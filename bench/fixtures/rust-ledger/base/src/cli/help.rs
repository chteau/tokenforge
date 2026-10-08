pub const USAGE: &str = "\
tally - a plain-text expense ledger

usage: tally [--dir DIR] [--format table|json|csv] <command> [args]

commands:
  init                                create an empty ledger
  add DATE AMOUNT CATEGORY [options]  record an expense (or income with --income)
  list [options]                      list entries
  edit ID [options]                   change fields of an entry
  remove ID                           delete an entry
  rename-category OLD NEW             move every entry in OLD to NEW
  categories                          totals per category
  report monthly [--year YYYY]        totals per month
  report categories [selection]       spending breakdown by category
  import FILE [--category C] [--dry-run]
                                      import a bank CSV export
  config                              show the effective configuration
  help [COMMAND]                      show help

The data directory is --dir, else $TALLY_DIR, else $HOME/.tally.
Run `tally help COMMAND` for the options of a command.
";

pub fn command_help(cmd: &str) -> Option<&'static str> {
    Some(match cmd {
        "add" => {
            "\
usage: tally add DATE AMOUNT CATEGORY [--payee P] [--note N] [--tag T]... [--income]

DATE is YYYY-MM-DD, AMOUNT a positive decimal such as 12.50.
"
        }
        "list" => {
            "\
usage: tally list [--filter EXPR] [--month YYYY-MM | --from DATE --to DATE]
                  [--sort date|amount|category|payee|id] [--desc] [--limit N]

EXPR example: category=food and amount>=20 and not payee~market
"
        }
        "edit" => {
            "\
usage: tally edit ID [--date D] [--amount A] [--category C] [--payee P]
                     [--note N] [--tag T]... [--clear-tags] [--income | --expense]
"
        }
        "report" => {
            "\
usage: tally report monthly [--year YYYY]
       tally report categories [--filter EXPR] [--month YYYY-MM | --from D --to D]
"
        }
        "import" => {
            "\
usage: tally import FILE [--category C] [--dry-run]

FILE is a bank CSV export with Date (DD/MM/YYYY), Description and Amount columns.
"
        }
        "remove" => "usage: tally remove ID\n",
        "rename-category" => "usage: tally rename-category OLD NEW\n",
        "categories" => "usage: tally categories\n",
        "init" => "usage: tally init\n",
        "config" => "usage: tally config\n",
        _ => return None,
    })
}
