import pandas as pd
import glob


if __name__ == '__main__':
    path = "/Users/curtisrollo/desktop/CSVEXCEL/csvexcel720/*.csv"
    for csv in glob.glob(path):
        main = pd.read_csv('/Users/curtisrollo/desktop/derek/all.csv')
        df = pd.read_csv(csv)
        print(df)
        city1 = csv.replace(".csv", "")
        city = city1.replace("/Users/curtisrollo/desktop/finished101/", "")
        df.insert(1, 'city', city)
        df.to_csv(csv, index=False)
        main = main.append(df)
        main.to_csv("/Users/curtisrollo/desktop/EMAILCSV/.csv", index=False)
